import { Button } from '../../components/ui/Button';
import s from './SendBar.module.css';

/** Панель действий над потоками кампании: «Отправить в Кейтаро»
 *  (применяет отложенные изменения), счётчик изменений и
 *  «Обновить из Кейтаро» (повторный запрос живых данных без
 *  перезагрузки страницы). */
export function SendBar({
  sending,
  refreshing,
  pendingCount,
  adds,
  removes,
  onSend,
  onRefresh,
  buttonRef,
  refreshButtonRef,
}: {
  sending: boolean;
  refreshing: boolean;
  pendingCount: number;
  adds: number;
  removes: number;
  onSend: () => void;
  onRefresh: () => void;
  buttonRef: React.Ref<HTMLButtonElement>;
  refreshButtonRef: React.Ref<HTMLButtonElement>;
}) {
  // Взаимное исключение: apply и refresh пишут/перечитывают один и тот же
  // список — пока идёт один, второй недоступен.
  const disabled = sending || refreshing || pendingCount === 0;
  const title = sending
    ? 'Sending…'
    : refreshing
      ? 'Refreshing…'
      : pendingCount === 0
        ? 'No pending changes'
        : '';
  return (
    <div className={s.sectionTop}>
       <Button
        variant="secondary"
        className={s.refresh}
        disabled={sending || refreshing}
        title={refreshing ? 'Refreshing…' : ''}
        onClick={onRefresh}
        buttonRef={refreshButtonRef}
      >
        {refreshing ? 'Refreshing…' : 'Refresh from Keitaro'} <span className={s.fetchKeitaro}></span>
      </Button>
      <div className={s.bar}>
        <Button
        variant="primary"
        disabled={disabled}
        title={title}
        onClick={onSend}
        buttonRef={buttonRef}
      >
        Send to Keitaro
      </Button>
      <span className={s.count}>
        {!pendingCount
          ? 'No changes'
          : `Changes: ${[adds ? `+${adds}` : '', removes ? `−${removes}` : ''].filter(Boolean).join(' / ')}`}
      </span>
      </div>
     
    </div>
  );
}
