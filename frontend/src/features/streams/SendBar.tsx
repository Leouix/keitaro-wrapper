import { Button } from '../../components/ui/Button';
import s from './SendBar.module.css';

/** Панель отправки: primary-кнопка и счётчик изменений. */
export function SendBar({
  sending,
  pendingCount,
  adds,
  removes,
  onSend,
  buttonRef,
}: {
  sending: boolean;
  pendingCount: number;
  adds: number;
  removes: number;
  onSend: () => void;
  buttonRef: React.Ref<HTMLButtonElement>;
}) {
  const disabled = sending || pendingCount === 0;  const title = sending
    ? 'Идёт отправка…'
    : pendingCount === 0
      ? 'Нет отложенных изменений'
      : '';
  return (
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
  );
}
