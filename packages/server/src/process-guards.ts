/**
 * A promise rejected outside a turn must not take the server down. Node's default is
 * to crash the process on an unhandled rejection, which kills every turn that is
 * running at that moment without a terminal status, so the rejection is logged and the
 * server keeps serving. An uncaught exception leaves the process in an unknown state,
 * so it is logged and the process exits; startup recovery then marks the turns that
 * were running.
 */
export interface ProcessGuardSink {
  write(line: string): void;
}

export function installProcessGuards(sink: ProcessGuardSink = process.stderr): void {
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    sink.write('tuffcode server: unhandled rejection outside a turn: ' + message + '\n');
  });
  process.on('uncaughtException', (error) => {
    sink.write('tuffcode server: uncaught exception: ' + error.message + '\n');
    process.exit(1);
  });
}
