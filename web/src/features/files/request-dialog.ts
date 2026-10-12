/**
 * One dialog with one request behind it: its open / pending / error state. `subject` is what the
 * dialog was opened for. A newer dialog, `close` and unmount abort the request, and a result that
 * arrives for a dialog no longer current is dropped. 新建文件夹 and the entry operations of
 * `WorkspaceBrowser` are built on it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../lib/api.js";
import { errorMessage, isUnauthorized } from "./errors.js";

type RequestDialogState<T> = {
  id: number;
  subject: T;
  error: string | null;
  pending: boolean;
};

export function useRequestDialog<T>() {
  const [dialog, setDialog] = useState<RequestDialogState<T> | null>(null);
  const dialogIdRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const mutationRef = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      dialogIdRef.current = null;
      mutationRef.current?.abort();
      mutationRef.current = null;
    };
  }, []);

  const close = useCallback(() => {
    dialogIdRef.current = null;
    mutationRef.current?.abort();
    mutationRef.current = null;
    setDialog(null);
  }, []);

  /** `trigger` 是取消类关闭后拿回焦点的元素。 */
  const open = useCallback((subject: T, trigger: HTMLElement | null) => {
    mutationRef.current?.abort();
    mutationRef.current = null;
    sequenceRef.current += 1;
    dialogIdRef.current = sequenceRef.current;
    returnFocus.current = trigger;
    setDialog({ id: sequenceRef.current, subject, error: null, pending: false });
  }, []);

  /**
   * 为当前对话框发出 `request`；已有一次在途时什么都不做。成功：关闭对话框，再调 `onDone`。失败：
   * 对话框留着并显示文案——409 是 `conflictText`（没给就同其余），其余是信封 message；401 不显示
   * （登录层接手）。
   */
  const submit = useCallback(
    (
      request: (signal: AbortSignal) => Promise<unknown>,
      onDone: () => void,
      conflictText?: string,
    ) => {
      const dialogId = dialogIdRef.current;
      if (dialogId === null || mutationRef.current) {
        return;
      }

      const controller = new AbortController();
      mutationRef.current = controller;
      setDialog((current) =>
        current?.id === dialogId ? { ...current, error: null, pending: true } : current,
      );
      const stale = () =>
        !mountedRef.current || controller.signal.aborted || dialogIdRef.current !== dialogId;
      void request(controller.signal)
        .then(() => {
          if (stale()) {
            return;
          }

          dialogIdRef.current = null;
          mutationRef.current = null;
          setDialog(null);
          onDone();
        })
        .catch((error: unknown) => {
          if (stale() || isUnauthorized(error)) {
            return;
          }

          mutationRef.current = null;
          const conflict = error instanceof ApiError && error.status === 409 ? conflictText : null;
          const message = conflict ?? errorMessage(error);
          setDialog((current) =>
            current?.id === dialogId ? { ...current, error: message, pending: false } : current,
          );
        });
    },
    [],
  );

  return { close, dialog, open, returnFocus, submit };
}
