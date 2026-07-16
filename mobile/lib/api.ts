import { Platform } from 'react-native';
import Constants from 'expo-constants';

const API_PORT = process.env.EXPO_PUBLIC_API_PORT ?? '8000';

/**
 * Backend base URL for dev:
 * - EXPO_PUBLIC_API_HOST override (LAN IP for physical device)
 * - Expo debugger host (same machine / LAN when using expo start)
 * - Android emulator → 10.0.2.2
 * - Default → 127.0.0.1 (web on PC)
 */
export function getApiBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (envUrl) {
    // Prevent double /api prefix if the env var was set to "/api" or "http://host/api"
    return envUrl.endsWith('/api') ? envUrl.slice(0, -4) : envUrl;
  }

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (window.location.hostname.includes('netlify.app') || window.location.hostname.includes('vercel.app') || window.location.hostname === 'drivelegal.in') {
      return ''; // Same-origin: let the Netlify proxy forward /api/* to EC2
    }
    if (window.location.hostname.includes('onrender.com')) {
      return 'https://13.222.36.11.nip.io'; // HTTPS backend (avoids mixed-content block)
    }
  }

  const envHost = process.env.EXPO_PUBLIC_API_HOST?.trim();
  if (envHost) {
    return `http://${envHost}:${API_PORT}`;
  }

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost') {
      return `http://${host}:${API_PORT}`;
    }
  }

  // Release builds: always hit the production backend
  if (!__DEV__) {
    return 'https://13.222.36.11.nip.io';
  }

  if (Platform.OS === 'android') {
    return `http://10.0.2.2:${API_PORT}`;
  }

  return `http://127.0.0.1:${API_PORT}`;
}
