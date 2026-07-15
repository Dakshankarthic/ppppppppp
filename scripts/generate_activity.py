import os
import random
import subprocess
from datetime import datetime, timedelta

def generate_commits():
    remotes_to_push = ['dakshan', 'iitm', 'new_pppppp']

    # Spread commits from May 25th to today
    start_date = datetime(2026, 5, 25)
    end_date = datetime(2026, 7, 14)

    current_date = start_date
    commit_count = 0

    print(f"Starting to generate commits from {start_date.date()} to {end_date.date()}...")

    while current_date <= end_date:
        # 85% chance to have activity on any given day
        if random.random() < 0.85:
            # 20% chance of a "dark green" highly active day (15-35 commits)
            # 80% chance of a regular active day (2-10 commits)
            if random.random() < 0.20:
                commits_today = random.randint(15, 35)
            else:
                commits_today = random.randint(2, 10)
            
            for _ in range(commits_today):
                # Pick a random time between 9:00 AM and 11:59 PM
                hour = random.randint(9, 23)
                minute = random.randint(0, 59)
                second = random.randint(0, 59)
                
                commit_time = current_date.replace(hour=hour, minute=minute, second=second)
                date_str = commit_time.strftime("%Y-%m-%dT%H:%M:%S")

                # Set both Author and Committer date
                env = os.environ.copy()
                env["GIT_AUTHOR_DATE"] = date_str
                env["GIT_COMMITTER_DATE"] = date_str

                # Create an empty commit
                commit_message = f"Routine updates - {date_str}"
                subprocess.run(
                    ['git', 'commit', '--allow-empty', '-m', commit_message],
                    env=env,
                    stdout=subprocess.DEVNULL
                )
                commit_count += 1

        # Move to the next day
        current_date += timedelta(days=1)

    print(f"Created {commit_count} fake commits.")

    for remote in remotes_to_push:
        print(f"Pushing to remote: {remote}...")
        subprocess.run(['git', 'push', '--force', remote, 'main'])

    print("Done!")

if __name__ == "__main__":
    generate_commits()
