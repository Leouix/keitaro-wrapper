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
    ? 'Идёт отправка…'
    : refreshing
      ? 'Идёт обновление…'
      : pendingCount === 0
        ? 'Нет отложенных изменений'
        : '';
  return (
    <div className={s.sectionTop}>
       <Button
        variant="secondary"
        className={s.refresh}
        disabled={sending || refreshing}
        title={refreshing ? 'Идёт обновление…' : ''}
        onClick={onRefresh}
        buttonRef={refreshButtonRef}
      >
        {refreshing ? 'Обновляем…' : 'Обновить из Кейтаро'} <span className={s.fetchKeitaro}></span>
      </Button>
      <div className={s.bar}>
        <Button
        variant="primary"
        disabled={disabled}
        title={title}
        onClick={onSend}
        buttonRef={buttonRef}
      >
        Отправить в Кейтаро
      </Button>
      <span className={s.count}>
        {!pendingCount
          ? 'Изменений нет'
          : `Изменений: ${[adds ? `+${adds}` : '', removes ? `−${removes}` : ''].filter(Boolean).join(' / ')}`}
      </span>
      </div>
     
    </div>
  );
}
