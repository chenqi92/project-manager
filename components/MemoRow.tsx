import { useState } from 'react';
import { AlertTriangle, CalendarClock, Trash2 } from 'lucide-react';
import { Button, Input, cx } from './ui';
import type { MemoItem } from '@/lib/types';
import { dueLabel, dueState, isAlarming, parseDateInput } from '@/lib/memo';

/** 单条备忘的展示行。省略某个回调即隐藏对应操作（用于只读/大屏）。 */
export function MemoRow({
  memo,
  onToggleDone,
  onToggleUrgent,
  onDelete,
}: {
  memo: MemoItem;
  onToggleDone?: () => void;
  onToggleUrgent?: () => void;
  onDelete?: () => void;
}) {
  const now = Date.now();
  const ds = dueState(memo, now);
  const alarm = isAlarming(memo, now);
  return (
    <div
      className={cx(
        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm',
        alarm
          ? 'memo-shake border-rose-300 bg-rose-50'
          : memo.done
            ? 'border-gray-200 bg-gray-50'
            : 'border-gray-200 bg-surface',
      )}
    >
      {onToggleDone ? (
        <input type="checkbox" checked={memo.done} onChange={onToggleDone} className="shrink-0" />
      ) : (
        <span
          className={cx(
            'h-3.5 w-3.5 shrink-0 rounded-full border',
            memo.done ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300',
          )}
        />
      )}
      <span
        className={cx(
          'min-w-0 flex-1 break-words',
          memo.done ? 'text-gray-400 line-through' : alarm ? 'text-rose-700' : 'text-gray-700',
        )}
      >
        {memo.text}
      </span>
      {memo.dueAt && (
        <span
          className={cx(
            'flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]',
            memo.done
              ? 'bg-gray-100 text-gray-400'
              : ds === 'overdue'
                ? 'bg-rose-100 text-rose-700'
                : ds === 'soon'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-gray-100 text-gray-500',
          )}
        >
          <CalendarClock size={11} /> {dueLabel(memo.dueAt, now)}
        </span>
      )}
      {onToggleUrgent && (
        <button
          onClick={onToggleUrgent}
          title={memo.urgent ? '取消紧急' : '标记紧急'}
          className={cx(
            'shrink-0 rounded p-0.5',
            memo.urgent ? 'text-rose-600' : 'text-gray-300 hover:text-gray-500',
          )}
        >
          <AlertTriangle size={13} />
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title="删除"
          className="shrink-0 rounded p-0.5 text-gray-300 hover:text-rose-600"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

/** 备忘添加表单：文本 + 截止日期 + 紧急。 */
export function AddMemo({
  onAdd,
  autoFocus,
}: {
  onAdd: (text: string, dueAt: number | undefined, urgent: boolean) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [urgent, setUrgent] = useState(false);
  const submit = () => {
    if (!text.trim()) return;
    onAdd(text.trim(), parseDateInput(due), urgent);
    setText('');
    setDue('');
    setUrgent(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder="新增备忘…"
        className="min-w-[8rem] flex-1"
      />
      <input
        type="date"
        value={due}
        onChange={(e) => setDue(e.target.value)}
        title="截止时间（可选）"
        className="rounded-lg border border-gray-300 px-2 py-2 text-sm text-gray-600 outline-none focus:border-brand-500"
      />
      <label className="flex items-center gap-1 text-xs text-gray-500" title="紧急">
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        紧急
      </label>
      <Button variant="subtle" onClick={submit} disabled={!text.trim()}>
        添加
      </Button>
    </div>
  );
}
