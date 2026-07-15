import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { checkCloudAvailable } from '../lib/tiers/smartSwitch';
import { streamCloud, queryCloudOnce } from '../lib/tiers/tier1Cloud';
import { loadTinyModel, generateTiny, isTinyModelLoaded } from '../lib/tiers/tier3Tiny';
import type { TinyLoadProgress } from '../lib/tiers/tier3Tiny';
import type { ChatHistoryTurn, QueryResult } from './useQuery';

export type Tier = 'cloud' | 'tiny' | 'offline';
export type TinyModelStatus = 'idle' | 'downloading' | 'ready' | 'error';

const OFFLINE_NO_MODEL_MESSAGE_WEB =
  "You're offline and the cloud AI can't be reached right now. I can't look anything up until " +
  "one of those comes back — please check your connection and try again.";

const OFFLINE_MODEL_WARMING_MESSAGE_WEB =
  "You're offline and the cloud AI can't be reached right now. The on-device assistant is " +
  'still downloading in the background — give it a moment and try again.';

const OFFLINE_MESSAGE_NATIVE =
  "You're offline and the cloud AI can't be reached right now. Please check your connection and try again.";

interface UseSmartChatResult {
  data: QueryResult | null;
  streamingText: string;
  isLoading: boolean;
  isOffline: boolean;
  error: string | null;
  tier: Tier;
  tinyModelStatus: TinyModelStatus;
  tinyDownloadProgress: number;
  submitQuery: (
    text: string,
    history?: ChatHistoryTurn[],
    attachment?: { imageBase64?: string; imageMime?: string },
    userVehicle?: string,
    userLocation?: string,
    country?: string,
    state?: string
  ) => Promise<void>;
}

export function useSmartChat(): UseSmartChatResult {
  const [data, setData] = useState<QueryResult | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState<Tier>('cloud');
  const [tinyModelStatus, setTinyModelStatus] = useState<TinyModelStatus>('idle');
  const [tinyDownloadProgress, setTinyDownloadProgress] = useState(0);
  const tinyModelStatusRef = useRef<TinyModelStatus>('idle');
  tinyModelStatusRef.current = tinyModelStatus;

  // Silently warm up Tier 3 in the background as soon as the chat mounts, so it's already
  // cached and ready by the time the cloud is ever unreachable — no manual download step.
  // Skips on an explicit browser "data saver" signal where available; otherwise proceeds.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const conn = (typeof navigator !== 'undefined' && (navigator as any).connection) || null;
    if (conn?.saveData) return;

    setTinyModelStatus('downloading');
    loadTinyModel((p: TinyLoadProgress) => {
      if (typeof p.progress === 'number') setTinyDownloadProgress(p.progress);
    })
      .then(() => setTinyModelStatus('ready'))
      .catch((e) => {
        console.warn('Background tiny-model warmup failed:', e);
        setTinyModelStatus('error');
      });
  }, []);

  const runTiny = useCallback(async (text: string, history: ChatHistoryTurn[]) => {
    setTier('tiny');
    setStreamingText('');
    const answer = await generateTiny(text, history, {
      onToken: (token) => setStreamingText((prev) => prev + token),
      onReset: () => setStreamingText(''),
    });
    setData({ status: 'ok', response: answer, citations: [] });
  }, []);

  const runOfflineFallback = useCallback(() => {
    setTier('offline');
    setIsOffline(true);
    let message = OFFLINE_MESSAGE_NATIVE;
    if (Platform.OS === 'web') {
      message = tinyModelStatusRef.current === 'downloading' ? OFFLINE_MODEL_WARMING_MESSAGE_WEB : OFFLINE_NO_MODEL_MESSAGE_WEB;
    }
    setData({ status: 'ok', response: message, citations: [] });
  }, []);

  const submitQuery = useCallback(
    async (
      text: string,
      history: ChatHistoryTurn[] = [],
      attachment: { imageBase64?: string; imageMime?: string } = {},
      userVehicle?: string,
      userLocation?: string,
      country?: string,
      state?: string
    ) => {
      setIsLoading(true);
      setError(null);
      setData(null);
      setStreamingText('');
      setIsOffline(false);

      // Images always go through the existing non-streaming vision path — tiers/streaming are
      // text-only in this pass.
      if (attachment.imageBase64) {
        setTier('cloud');
        try {
          const result = await queryCloudOnce(text, history, attachment, userVehicle, userLocation, country, state);
          setData(result);
        } catch (err: any) {
          console.log('Vision query failed:', err);
          setIsOffline(true);
          setError(err?.message || 'Failed to analyze image.');
        } finally {
          setIsLoading(false);
        }
        return;
      }

      try {
        if (Platform.OS === 'web') {
          const cloudUp = await checkCloudAvailable();
          if (cloudUp) {
            setTier('cloud');
            try {
              let full = '';
              await streamCloud(
                text,
                history,
                { userVehicle, userLocation, country, state },
                {
                  onDelta: (delta) => {
                    full += delta;
                    setStreamingText(full);
                  },
                  onDone: (citations) => {
                    setData({ status: 'ok', response: full, citations });
                  },
                }
              );
              return;
            } catch (streamErr) {
              console.log('Cloud streaming failed, degrading to next tier:', streamErr);
              // fall through to tiny/offline below
            }
          }

          if (tinyModelStatusRef.current === 'ready' || isTinyModelLoaded()) {
            await runTiny(text, history);
            return;
          }

          runOfflineFallback();
          return;
        }

        // Native: unchanged /query call, but a friendly message instead of a raw error on failure.
        setTier('cloud');
        try {
          const result = await queryCloudOnce(text, history, {}, userVehicle, userLocation, country, state);
          setData(result);
        } catch (err) {
          console.log('Native cloud query failed:', err);
          runOfflineFallback();
        }
      } finally {
        setIsLoading(false);
      }
    },
    [runTiny, runOfflineFallback]
  );

  return {
    data,
    streamingText,
    isLoading,
    isOffline,
    error,
    tier,
    tinyModelStatus,
    tinyDownloadProgress,
    submitQuery,
  };
}
