import { useCallback, useRef, useState } from 'react';
import { acceptJson, detailToText, requestJson } from '../../api/client';
import type { ArchivedEntry, CampaignDetail, Offer, PendingRow, Stream } from '../../api/types';

export type PageError = {
  text: string;
  /** Действие в блоке ошибки: ссылка на главную, к кампаниям или «Повторить». */
  kind: 'home' | 'campaigns' | 'retry';
} | null;

export interface StreamsData {
  loading: boolean;
  /** Потоков нет вообще. */
  empty: boolean;
  pageError: PageError;
  /** Хотя бы один запрос страницы упал со статусом 0 (сервер/сеть недоступны):
   *  страница рисуется старыми данными, ошибки оферов собираются в один блок. */
  serverDown: boolean;
  streams: Stream[];
  offersMap: Map<number, Offer | null>;
  archive: ArchivedEntry[];
  pending: PendingRow[];
  campaignName: string | null;
  load: (opts?: { refresh?: boolean }) => Promise<boolean>;
  setStreams: (update: (prev: Stream[]) => Stream[]) => void;
  setArchive: (update: (prev: ArchivedEntry[]) => ArchivedEntry[]) => void;
  setPending: (update: (prev: PendingRow[]) => PendingRow[]) => void;
  setOffersMap: (update: (prev: Map<number, Offer | null>) => Map<number, Offer | null>) => void;
}

/**
 * Данные страницы потоков. Порядок запросов — как в web/app.js load():
 * сначала параллельно потоки и кампания, ЗАТЕМ архив (синхронизация
 * «офер пропал в Keitaro → reason=keitaro» коммитится в обработчике
 * /streams, поэтому параллельный запрос архива не видит свежую строку),
 * затем pending, затем все оферы параллельно.
 */
export function useStreamsData(campaignId: string): StreamsData {
  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [pageError, setPageError] = useState<PageError>(null);
  const [serverDown, setServerDown] = useState(false);
  const [streams, setStreams] = useState<Stream[]>([]);
  const [offersMap, setOffersMap] = useState<Map<number, Offer | null>>(new Map());
  const [archive, setArchive] = useState<ArchivedEntry[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(
    async (opts: { refresh?: boolean } = {}): Promise<boolean> => {
      const refresh = opts.refresh === true;
      const mySeq = ++seqRef.current;
      if (!refresh) {
        setLoading(true);
        setEmpty(false);
        setPageError(null);
      }

      // Название кампании и потоки запрашиваем параллельно.
      const [streamsRes, campaignRes] = await Promise.all([
        requestJson<Stream[]>(`/api/campaigns/${campaignId}/streams`, { headers: acceptJson }),
        requestJson<CampaignDetail>(`/api/campaigns/${campaignId}`, { headers: acceptJson }),
      ]);

      let archiveData: ArchivedEntry[] = [];
      const archiveRes = await requestJson<{ archived?: ArchivedEntry[] }>(
        `/api/campaigns/${campaignId}/streams/archive`,
        { headers: acceptJson },
      );
      if (archiveRes.status === 200 && archiveRes.body && Array.isArray(archiveRes.body.archived)) {
        archiveData = archiveRes.body.archived;
        setArchive(archiveData);
      } else if (!refresh) {
        setArchive([]); // ключа нет или список пуст — архива нет
      }

      // Восстановление жёлтых строк из pending: перезагрузка не воскрешает
      // удалённые оферы и не теряет черновики. 404 = старый бэкенд без
      // pending-роутов — считаем изменений нет.
      let pendingData: PendingRow[] = [];
      const pendingRes = await requestJson<{ pending?: PendingRow[] }>(
        `/api/campaigns/${campaignId}/streams/pending`,
        { headers: acceptJson },
      );
      if (pendingRes.status === 200 && pendingRes.body && Array.isArray(pendingRes.body.pending)) {
        pendingData = pendingRes.body.pending;
        setPending(pendingData);
      } else if (!refresh) {
        setPending([]);
      }

      // Ответ на устаревшую загрузку (повторная «Повторить» пришла раньше) — молча бросаем.
      if (mySeq !== seqRef.current) return false;

      // body.name || body.campaign?.name — stale-ответ кладёт кампанию внутрь.
      const campaignBody = campaignRes.ok ? campaignRes.body : null;
      const name =
        campaignBody && (campaignBody.name || (campaignBody.campaign && campaignBody.campaign.name));
      if (name) setCampaignName(name);

      const { status, body } = streamsRes;
      if (status !== 200 || !Array.isArray(body)) {
        if (refresh) return false;
        if (status === 409) {
          setPageError({ text: 'Сначала укажите API key.', kind: 'home' });
        } else if (status === 404) {
          setPageError({ text: 'Кампания не найдена.', kind: 'campaigns' });
        } else if (status === 502) {
          setPageError({ text: 'Keitaro недоступен.', kind: 'retry' });
        } else if (status === 0) {
          setPageError({ text: 'Сеть недоступна.', kind: 'retry' });
        } else {
          setPageError({
            text: detailToText((body as { detail?: unknown } | null)?.detail, `Ошибка загрузки (код ${status}).`),
            kind: 'retry',
          });
        }
        setLoading(false);
        return false;
      }

      const streamsData = body;
      setStreams(streamsData);

      // Уникальные offer_id → оферы параллельно; ошибка по одному не рушит остальные.
      // Берём живых оферов, архив И отложенные добавления: строка с бейджем
      // тоже рисует имя и выплату, иначе после перезагрузки офер из pending
      // рисуется как «не удалось загрузить офер».
      const ids = [
        ...new Set([
          ...streamsData.flatMap((s) => (Array.isArray(s.offers) ? s.offers : []).map((o) => o.offer_id)),
          ...archiveData.map((a) => a.offer_id),
          ...pendingData.filter((p) => p.action === 'add').map((p) => p.offer_id),
        ]),
      ];
      // Статус 0 у любого офера — сервер/сеть недоступны целиком: один флаг
      // на страницу, ошибки не дублируются по строкам.
      let offersServerDown = false;
      const results = await Promise.all(
        ids.map(async (id) => {
          const r = await requestJson<Offer>(`/api/offers/${id}`, { headers: acceptJson });
          if (r.status === 0) offersServerDown = true;
          return [id, r.ok ? r.body : null] as const;
        }),
      );
      if (mySeq !== seqRef.current) return false;

      setOffersMap(new Map(results.map(([id, offer]) => [id, offer])));
      setServerDown(offersServerDown);
      setLoading(false);

      if (!streamsData.length) {
        // Потоков нет вообще — прежний empty-state.
        setEmpty(true);
        return true;
      }
      return true;
    },
    [campaignId],
  );

  return {
    loading,
    empty,
    pageError,
    serverDown,
    streams,
    offersMap,
    archive,
    pending,
    campaignName,
    load,
    setStreams: (update) => setStreams(update),
    setArchive: (update) => setArchive(update),
    setPending: (update) => setPending(update),
    setOffersMap: (update) => setOffersMap(update),
  };
}
