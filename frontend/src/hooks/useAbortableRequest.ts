import { useCallback, useEffect, useRef } from 'react';
import { requestJson } from '../api/client';
import type { RequestResult } from '../api/types';

export interface AbortableRequest {
  /**
   * Выполняет запрос с AbortController; каждый новый вызов отменяет
   * предыдущий. stale=true — ответ на устаревший (или отменённый,
   * или после размонтирования) запрос: его надо молча выбросить.
   */
  request: <T>(
    url: string,
    init?: RequestInit,
  ) => Promise<{ result: RequestResult<T>; stale: boolean }>;
  /** Отменяет текущий запрос: все будущие ответы считаются устаревшими. */
  cancel: () => void;
}

export function useAbortableRequest(): AbortableRequest {
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  const request = useCallback(
    async <T,>(url: string, init: RequestInit = {}) => {
      seqRef.current += 1;
      const mySeq = seqRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const result = await requestJson<T>(url, { ...init, signal: controller.signal });
      return { result, stale: mySeq !== seqRef.current || !mountedRef.current };
    },
    [],
  );

  const cancel = useCallback(() => {
    seqRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  return { request, cancel };
}
