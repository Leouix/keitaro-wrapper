import { useEffect, useState } from 'react';
import { fetchCampaignOptions } from './campaignNewApi';
import type { CampaignOptions } from '../../api/types';

export type OptionsPhase = 'loading' | 'error' | 'ready';

export interface OptionsLoad {
  phase: OptionsPhase;
  options: CampaignOptions | null;
  /** Текст ошибки последней загрузки (для 409 — «нужен ключ»). */
  error: string | null;
  /** true при 409 — ключ не настроен, нужен переход на главную. */
  needKey: boolean;
  retry: () => void;
}

/** Загрузка GET /api/campaign-options: скелетон → ошибка/данные, с ручным «Повторить». */
export function useCampaignOptions(): OptionsLoad {
  const [phase, setPhase] = useState<OptionsPhase>('loading');
  const [options, setOptions] = useState<CampaignOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let disposed = false;
    (async () => {
      const { status, options: loaded, detail } = await fetchCampaignOptions();
      if (disposed) return;
      if (status === 200 && loaded) {
        setOptions(loaded);
        setError(null);
        setNeedKey(false);
        setPhase('ready');
        return;
      }
      if (status === 409) {
        setError('Set the API key first.');
        setNeedKey(true);
      } else if (status === 502) {
        setError('Keitaro is unavailable.');
        setNeedKey(false);
      } else if (status === 0) {
        setError('Network unavailable.');
        setNeedKey(false);
      } else {
        setError(detail || `Failed to load the dictionaries (status ${status}).`);
        setNeedKey(false);
      }
      setOptions(null);
      setPhase('error');
    })();
    return () => {
      disposed = true;
    };
  }, [nonce]);

  return {
    phase,
    options,
    error,
    needKey,
    retry: () => {
      setPhase('loading');
      setNonce((n) => n + 1);
    },
  };
}
