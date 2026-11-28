import { Terminal, paletteFor, paletteToXterm, type TerminalHandle } from '@tuffcode/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RpcClient } from '../../rpc/client';
import { useAppStore } from '../../store/app-store';
import { TERMINAL_MENU, type ActionContext } from '../actions';
import { useActionPorts } from '../menu/action-context';
import { useContextMenuTrigger } from '../menu/Menu';
import { subscribeTerminalData } from './terminal-data';
import { TerminalError, terminalErrorMessage } from './TerminalError';

/** Coalesce the resize storm a window drag produces into one RPC call. */
const RESIZE_DEBOUNCE_MS = 150;

export interface TerminalViewProps {
  terminalId: string;
  rpc: RpcClient;
  active: boolean;
  /** Replace a terminal whose pty stopped answering. */
  onReopen: (terminalId: string) => void;
}

export function TerminalView({ terminalId, rpc, active, onReopen }: TerminalViewProps) {
  const handleRef = useRef<TerminalHandle | null>(null);
  const resizeTimerRef = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const ports = useActionPorts();
  // Three primitive selectors, so a save elsewhere in Settings does not re-render the pty.
  const scrollback = useAppStore((state) => state.settings?.terminalScrollback);
  const fontSize = useAppStore((state) => state.settings?.terminalFontSize);
  const cursorStyle = useAppStore((state) => state.settings?.cursorStyle);
  const themeId = useAppStore((state) => state.settings?.theme);
  const terminalTheme = useMemo(() => paletteToXterm(paletteFor(themeId)), [themeId]);

  useEffect(() => {
    return subscribeTerminalData(rpc, terminalId, (data) => handleRef.current?.write(data));
  }, [rpc, terminalId]);

  // A hidden tab measures zero, so refit and focus once it becomes visible.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      handleRef.current?.fit();
      handleRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    return () => {
      clearTimeout(resizeTimerRef.current);
    };
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      void rpc.request('terminal.input', { terminalId, data }).then(
        () => setError(null),
        (cause: unknown) => setError(terminalErrorMessage(cause)),
      );
    },
    [rpc, terminalId],
  );

  const sendResize = useCallback(
    (size: { cols: number; rows: number }) => {
      clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = undefined;
        void rpc.request('terminal.resize', { terminalId, cols: size.cols, rows: size.rows }).then(
          () => setError(null),
          (cause: unknown) => setError(terminalErrorMessage(cause)),
        );
      }, RESIZE_DEBOUNCE_MS);
    },
    [rpc, terminalId],
  );

  const retry = useCallback(() => {
    setError(null);
    onReopen(terminalId);
  }, [onReopen, terminalId]);

  const context: ActionContext = {
    ...ports,
    terminal: {
      getSelection: () => handleRef.current?.getSelection() ?? '',
      write: sendInput,
      clear: () => handleRef.current?.clear(),
    },
  };
  const menuProps = useContextMenuTrigger(TERMINAL_MENU, context, { label: 'Terminal actions' });

  return (
    <div
      hidden={!active}
      data-terminal-id={terminalId}
      {...menuProps}
      className="absolute inset-0 focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset"
    >
      <Terminal
        ref={handleRef}
        autoFocus={active}
        fontSize={fontSize}
        scrollback={scrollback}
        cursorStyle={cursorStyle}
        theme={terminalTheme}
        onData={sendInput}
        onResize={sendResize}
        className="p-1.5"
      />
      {error ? (
        <div className="absolute inset-x-3 top-3">
          <TerminalError message={error} onRetry={retry} />
        </div>
      ) : null}
    </div>
  );
}
