import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI(
    api_key="sk-fc1d2eda6e9640f09208f3116e7cb945",
    base_url="https://api.deepseek.com"
)

async def test():
    try:
        r = await client.chat.completions.create(
            model="deepseek-chat",
            messages=[{"role": "user", "content": "say hello"}],
            max_tokens=10
        )
        print("SUCCESS:", r.choices[0].message.content)
    except Exception as e:
        print("ERROR:", type(e).__name__, str(e))

asyncio.run(test())
