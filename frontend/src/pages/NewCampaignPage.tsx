import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CampaignOptionItem, CreateCampaignResult } from '../api/types';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Message } from '../components/ui/Message';
import { PageHeader } from '../components/ui/PageHeader';
import { SkeletonRows } from '../components/ui/Skeleton';
import fm from '../components/ui/Field.module.css';
import { createCampaign } from '../features/campaign-new/campaignNewApi';
import { GeoPicker } from '../features/campaign-new/GeoPicker';
import { OfferPicker } from '../features/campaign-new/OfferPicker';
import type { OfferChip } from '../features/campaign-new/OfferPicker';
import { useCampaignOptions } from '../features/campaign-new/useCampaignOptions';
import s from './NewCampaignPage.module.css';

/** Группа кампаний по умолчанию — FORTESTS (план, раздел 7). */
const DEFAULT_GROUP_ID = 10332;
/** Ключ localStorage: последний выбор домена/группы/источника. */
const STORAGE_KEY = 'keitaro.createCampaign.last';
/** Максимум стран в одной кампании (план, раздел 6). */
const MAX_GEOS = 20;

/** Текст валидации «минимум одна страна» — совпадает с GeoPicker-ошибкой. */
const GEO_REQUIRED = 'Укажите хотя бы одну страну.';
/** Текст валидации «минимум один оффер» — совпадает с OfferPicker-ошибкой. */
const OFFER_REQUIRED = 'Укажите хотя бы один оффер.';
/** Максимум офферов в одной кампании — та же защита, что и для стран (план, §10). */
const MAX_OFFERS = 20;

interface SavedChoice {
  domainId?: number | null;
  groupId?: number | null;
  sourceId?: number | null;
}

function readSaved(): SavedChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedChoice) : null;
  } catch {
    return null;
  }
}

function saveChoice(value: { domainId: string; groupId: string; sourceId: string }) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        domainId: value.domainId ? Number(value.domainId) : null,
        groupId: value.groupId ? Number(value.groupId) : null,
        sourceId: value.sourceId ? Number(value.sourceId) : null,
      }),
    );
  } catch {
    // приватный режим и т.п. — запоминание не критично
  }
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  disabled,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: CampaignOptionItem[];
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div className={fm.field}>
      <label className={fm.label} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={fm.input}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!options.length && <option value="">{placeholder}</option>}
        {!value && options.length > 0 && (
          <option value="" disabled>
            Выберите…
          </option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} (ID {o.id})
          </option>
        ))}
      </select>
    </div>
  );
}

/** Страница «Создать кампанию»: POST /api/campaigns по контракту плана (разделы 6–7). */
export function NewCampaignPage() {
  const navigate = useNavigate();
  const { phase: optionsPhase, options, error: optionsError, needKey, retry } = useCampaignOptions();

  const [name, setName] = useState('');
  const [geos, setGeos] = useState<string[]>([]);
  const [offers, setOffers] = useState<OfferChip[]>([]);
  // Явный выбор пользователя; null — «не трогал», действует дефолт.
  const [domainChoice, setDomainChoice] = useState<string | null>(null);
  const [groupChoice, setGroupChoice] = useState<string | null>(null);
  const [sourceChoice, setSourceChoice] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: number | null } | null>(null);
  const [success, setSuccess] = useState<CreateCampaignResult | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const optionsErrorRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const duplicateRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    document.title = 'Создать кампанию — Keitaro';
  }, []);

  // Дефолты вычисляются при рендере, без setState-эффекта: селект включается
  // в том же коммите, где уже имеет непустое значение (ни кадра пустого
  // селекта, ни «Выберите домен», если домен ровно один).
  // Порядок: явный выбор пользователя → последний выбор из localStorage →
  // единственный элемент списка → группа FORTESTS.
  const defaults = useMemo(() => {
    if (!options) return { domain: '', group: '', source: '' };
    const saved = readSaved();
    const pick = (
      list: CampaignOptionItem[],
      savedId: number | null | undefined,
      fallback: () => number | null,
    ) => {
      if (savedId != null && list.some((o) => o.id === savedId)) return String(savedId);
      return String(fallback() ?? '');
    };
    return {
      domain: pick(options.domains, saved?.domainId, () =>
        options.domains.length === 1 ? options.domains[0].id : null,
      ),
      group: pick(options.groups, saved?.groupId, () =>
        (options.groups.find((g) => g.id === DEFAULT_GROUP_ID) ?? options.groups[0])?.id ?? null,
      ),
      source: pick(options.sources, saved?.sourceId, () =>
        options.sources.length === 1 ? options.sources[0].id : null,
      ),
    };
  }, [options]);

  /** Эффективное значение: явный выбор (если ещё в списке) → дефолт. */
  function effective(choice: string | null, list: CampaignOptionItem[] | undefined, fallback: string): string {
    if (choice != null && (!list || list.some((o) => String(o.id) === choice))) return choice;
    return list ? fallback : (choice ?? '');
  }

  const domainId = effective(domainChoice, options?.domains, defaults.domain);
  const groupId = effective(groupChoice, options?.groups, defaults.group);
  const sourceId = effective(sourceChoice, options?.sources, defaults.source);

  // Последний выбор запоминается сразу при изменении селектов.
  useEffect(() => {
    if (optionsPhase === 'ready') {
      saveChoice({ domainId, groupId, sourceId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domainId, groupId, sourceId, optionsPhase]);

  // Фокус: ошибка формы → блок ошибки, дубль → подтверждение, успех → карточка.
  useEffect(() => {
    if (formError) errorRef.current?.focus();
  }, [formError]);
  useEffect(() => {
    if (duplicate) duplicateRef.current?.focus();
  }, [duplicate]);
  useEffect(() => {
    if (success) successRef.current?.focus();
  }, [success]);

  function resetSuccess() {
    setSuccess(null);
    setName('');
    setGeos([]);
    setOffers([]);
    setFormError(null);
    setDuplicate(null);
    nameRef.current?.focus();
  }

  function validate(): string {
    if (!name.trim()) return 'Укажите название кампании.';
    if (!geos.length) return GEO_REQUIRED;
    if (!offers.length) return OFFER_REQUIRED;
    if (optionsPhase === 'ready') {
      if (!domainId) return 'Выберите домен.';
      if (!groupId) return 'Выберите группу кампаний.';
      if (!sourceId) return 'Выберите источник трафика.';
    }
    return '';
  }

  async function submit(confirmDuplicate: boolean) {
    if (busyRef.current) return;

    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    setDuplicate(null);

    const payload = {
      name: name.trim(),
      geos,
      offer_ids: offers.map((o) => o.id),
      domain_id: domainId ? Number(domainId) : 0,
      group_id: groupId ? Number(groupId) : 0,
      traffic_source_id: sourceId ? Number(sourceId) : 0,
      confirm_duplicate: confirmDuplicate,
    };
    const { status, body, detail, bodyId } = await createCampaign(payload);

    busyRef.current = false;
    setBusy(false);

    if (status === 201 && body?.campaign) {
      setSuccess(body);
      return;
    }
    if (status === 409) {
      setDuplicate({ id: bodyId });
      return;
    }
    if (status === 422) {
      setFormError(detail || 'Проверьте значения полей.');
      return;
    }
    if (status === 403) {
      setFormError(detail || 'Нет прав у ключа.');
      return;
    }
    if (status === 502) {
      // detail содержит шаг сбоя, если кампания не собралась целиком.
      setFormError(detail ? `Keitaro недоступен: ${detail}` : 'Keitaro недоступен.');
      return;
    }
    if (status === 0) {
      setFormError('Сеть недоступна.');
      return;
    }
    setFormError(detail || `Не удалось создать кампанию (код ${status}).`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(false);
  }

  const ready = optionsPhase === 'ready' && options;
  const hintId = 'geo-hint';
  const offerHintId = 'offer-hint';

  return (
    <div className="page">
      <section className="card">
        <PageHeader
          crumbs={[
            { label: 'Главная', to: '/' },
            { label: 'Кампании', to: '/campaigns' },
            { label: 'Создание кампании' },
          ]}
          title="Создать кампанию" />

        {optionsPhase === 'loading' && (
          <div aria-busy="true">
            <p className="sr-only" role="status">
              Загружаем справочники…
            </p>
            <SkeletonRows rows={4} />
          </div>
        )}

        {optionsPhase === 'error' && (
          <div ref={optionsErrorRef} role="alert" tabIndex={-1} className={s.optionsError}>
            <Message kind="error">{optionsError}</Message>
            <div className={s.errorActions}>
              {needKey && (
                <Link to="/" className="link">
                  Указать API key на главной
                </Link>
              )}
              <Button size="md" onClick={retry}>
                Повторить
              </Button>
            </div>
          </div>
        )}

        {success ? (
          <div ref={successRef} tabIndex={-1} role="status" className={s.success}>
            <Message kind="success">Кампания создана</Message>
            <dl className={s.successList}>
              <div className={s.successRow}>
                <dt>ID кампании</dt>
                <dd>{success.campaign.id}</dd>
              </div>
              <div className={s.successRow}>
                <dt>Alias</dt>
                <dd className="tabular">{success.campaign.alias ?? '—'}</dd>
              </div>
              <div className={s.successRow}>
                <dt>Ссылка</dt>
                <dd className="wrap-anywhere">
                  <a href={success.campaign.url ?? (success.campaign.alias ? `https://kylovoa.com/${success.campaign.alias}` : '#')} target="_blank" rel="noreferrer">
                    {success.campaign.url ?? (success.campaign.alias ? `https://kylovoa.com/${success.campaign.alias}` : '—')}
                  </a>
                </dd>
              </div>
            </dl>
            <div className={s.successActions}>
              <Button
                variant="primary"
                onClick={() => navigate(`/fb/campaigns/${success.campaign.id}/streams`)}
              >
                Открыть потоки
              </Button>
              <Button onClick={resetSuccess}>Создать ещё</Button>
            </div>
          </div>
        ) : (
          optionsPhase !== 'loading' && (
            <form onSubmit={onSubmit} noValidate>
              <Field
                id="campaign-name"
                label="Название кампании"
                name="campaign_name"
                autoComplete="off"
                spellCheck={false}
                inputRef={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

              <div className={s.geoField}>
                <label className={fm.label} htmlFor="geo-input">
                  Гео — страны трафика
                </label>
                <GeoPicker
                  id="geo-input"
                  hintId={hintId}
                  selected={geos}
                  onChange={setGeos}
                  error={formError === GEO_REQUIRED ? GEO_REQUIRED : null}
                  max={MAX_GEOS}
                />
              </div>

              <div className={s.offerField}>
                <label className={fm.label} htmlFor="offer-input">
                  Офферы — ID через запятую
                </label>
                <OfferPicker
                  id="offer-input"
                  hintId={offerHintId}
                  selected={offers}
                  onChange={setOffers}
                  error={formError === OFFER_REQUIRED ? OFFER_REQUIRED : null}
                  max={MAX_OFFERS}
                />
              </div>

              <SelectField
                id="campaign-domain"
                label="Домен"
                value={domainId}
                onChange={setDomainChoice}
                options={options?.domains ?? []}
                disabled={!ready}
                placeholder="Не загружено"
              />
              <SelectField
                id="campaign-group"
                label="Группа кампаний"
                value={groupId}
                onChange={setGroupChoice}
                options={options?.groups ?? []}
                disabled={!ready}
                placeholder="Не загружено"
              />
              <SelectField
                id="campaign-source"
                label="Источник трафика"
                value={sourceId}
                onChange={setSourceChoice}
                options={options?.sources ?? []}
                disabled={!ready}
                placeholder="Не загружено"
              />

              {formError && (
                <div ref={errorRef} role="alert" tabIndex={-1} className={s.formError}>
                  <Message kind="error">{formError}</Message>
                </div>
              )}

              {duplicate && (
                <div ref={duplicateRef} role="alert" tabIndex={-1} className={s.duplicate}>
                  <Message kind="warn">Кампания с таким названием уже есть, создать ещё одну?</Message>
                  <div className={s.errorActions}>
                    {duplicate.id != null && (
                      <Link to={`/fb/campaigns/${duplicate.id}/streams`} className="link">
                        Открыть существующую (ID {duplicate.id})
                      </Link>
                    )}
                    <Button
                      variant="danger"
                      disabled={busy}
                      aria-busy={busy || undefined}
                      onClick={() => void submit(true)}
                    >
                      Всё равно создать
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setDuplicate(null);
                        nameRef.current?.focus();
                      }}
                    >
                      Отменить
                    </Button>
                  </div>
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                disabled={busy}
                aria-busy={busy || undefined}
              >
                {busy ? 'Создаём…' : 'Создать кампанию'}
              </Button>
            </form>
          )
        )}
      </section>
    </div>
  );
}
