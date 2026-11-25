import { execFileSync } from 'node:child_process';
import type { Rectangle } from 'electron';
import { expect, test } from './fixtures';
import { MOCK_MODEL_ID } from './mock-openai';

/**
 * Real-input regression for the topbar drag region. A control inside a
 * `-webkit-app-region: drag` strip only receives real mouse clicks when its
 * `no-drag` box is in normal flow: an absolutely positioned wrapper is never
 * subtracted, so Windows answers WM_NCHITTEST with HTCAPTION and the click drags
 * the window. Playwright's click() injects through CDP and passes either way, which
 * is how the mode switch stayed dead after it moved into the topbar (PR #173).
 */
const HTCLIENT = 1;
const HTCAPTION = 2;

interface Point {
  x: number;
  y: number;
}

interface Hit {
  x: number;
  y: number;
  result: number;
}

function hitTest(hwnd: string, points: Point[]): Hit[] {
  const list = points.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(';');
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TuffcodeHitTest {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[TuffcodeHitTest]::SetProcessDPIAware() | Out-Null
$hwnd = [IntPtr]::new([long]${hwnd})
foreach ($pair in '${list}'.Split(';')) {
  $xy = $pair.Split(',')
  $x = [int]$xy[0]; $y = [int]$xy[1]
  $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
  $r = [int]([TuffcodeHitTest]::SendMessage($hwnd, 0x0084, [IntPtr]::Zero, $lp))
  Write-Output ("$x,$y=$r")
}
`;
  const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return output
    .split(/\r?\n/)
    .map((line) => /^(-?\d+),(-?\d+)=(-?\d+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), result: Number(match[3]) }));
}

function foreground(title: string): void {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$shell = New-Object -ComObject WScript.Shell; $shell.AppActivate('${title}') | Out-Null`,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
}

test.describe('topbar hit test', () => {
  test.skip(process.platform !== 'win32', 'WM_NCHITTEST only exists on Windows');

  test('the mode switch is a real client area, not a window caption', async ({
    session,
    workspace,
    mock,
    rpc,
  }) => {
    const { page, app } = session;
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.evaluate(() => {
      document.title = 'Tuffcode hit test';
    });

    const project = (await rpc.request('projects.add', { path: workspace.projectPath })) as {
      id: string;
    };
    const provider = (await rpc.request('providers.upsert', {
      kind: 'openai-compatible',
      label: 'Mock Provider',
      config: { baseUrl: mock.baseUrl },
    })) as { id: string };
    await rpc.request('settings.set', {
      patch: { defaultProviderId: provider.id, defaultModelId: MOCK_MODEL_ID },
    });
    const thread = (await rpc.request('threads.create', {
      projectId: project.id,
      providerId: provider.id,
      modelId: MOCK_MODEL_ID,
      executionMode: 'work',
      permissionMode: 'full-auto',
    })) as { id: string };
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/project/${project.id}/thread/${thread.id}`);
    await page.reload();
    await expect(page.getByTestId('thread-title')).toBeVisible({ timeout: 30_000 });

    const readWindow = (): Promise<{ bounds: Rectangle | undefined; scale: number; hwnd: string | null }> =>
      app.evaluate(({ BrowserWindow, screen }) => {
        const target = BrowserWindow.getAllWindows()[0];
        const handle = target?.getNativeWindowHandle();
        return {
          bounds: target?.getBounds(),
          scale: screen.getPrimaryDisplay().scaleFactor,
          hwnd: handle ? handle.readBigInt64LE(0).toString() : null,
        };
      });

    const modeSwitch = page.getByTestId('thread-mode-switch');
    const councilSegment = modeSwitch.getByRole('radio', { name: 'Council' });

    // Every width where the topbar switch is the visible control. The narrow end is where
    // the right cluster is widest, so it is the band where an overflowing sibling could paint
    // over the switch and swallow the click.
    for (const width of [1440, 1100, 1000, 900]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size, 800),
        width,
      );
      await page.waitForTimeout(300);
      const geometry = await readWindow();
      const { bounds } = geometry;
      if (!bounds || geometry.hwnd === null) throw new Error('could not read the window geometry');

      const switchBox = await modeSwitch.boundingBox();
      const councilBox = await councilSegment.boundingBox();
      if (!switchBox || !councilBox) throw new Error(`the mode switch is missing at ${width}px`);

      // The window-controls inset sits on the right cluster, not the header, so the middle
      // track is centred on the window and not on an asymmetric content box.
      const viewportWidth = await page.evaluate(() => window.innerWidth);
      expect(
        Math.abs(switchBox.x + switchBox.width / 2 - viewportWidth / 2),
        `the mode switch must be centred at ${width}px`,
      ).toBeLessThanOrEqual(1.5);
      const toScreen = (box: { x: number; y: number; width: number; height: number }): Point => ({
        x: (bounds.x + box.x + box.width / 2) * geometry.scale,
        y: (bounds.y + box.y + box.height / 2) * geometry.scale,
      });
      const switchPoint = toScreen(switchBox);
      const councilPoint = toScreen(councilBox);
      // The header's own leading padding: it must stay a caption area at every width, which
      // also proves the window is answering the probe from its live draggable region.
      const headerPoint = toScreen({ x: 4, y: 26, width: 1, height: 1 });

      let hits = hitTest(geometry.hwnd, [headerPoint, switchPoint, councilPoint]);
      if (hits[0]?.result !== HTCAPTION) {
        // Chromium reports the draggable region only once the window has been activated.
        foreground('Tuffcode hit test');
        hits = hitTest(geometry.hwnd, [headerPoint, switchPoint, councilPoint]);
      }
      const [header, toggle, council] = hits;
      expect(header?.result, `the topbar background must stay a caption area at ${width}px`).toBe(
        HTCAPTION,
      );
      expect(toggle?.result, `the mode switch must be a client area at ${width}px`).toBe(HTCLIENT);
      expect(council?.result, `the Council segment must be a client area at ${width}px`).toBe(
        HTCLIENT,
      );

      // A caption-free point is not enough: a sibling painted above it would still eat the
      // click, so the topmost element at the segment's center must be the Council segment.
      const topmost = await page.evaluate(
        (point: Point) => {
          const radio = document.elementFromPoint(point.x, point.y)?.closest('[role="radio"]');
          return radio?.textContent?.trim() ?? null;
        },
        { x: councilBox.x + councilBox.width / 2, y: councilBox.y + councilBox.height / 2 },
      );
      expect(topmost, `the Council segment must be the topmost element at ${width}px`).toBe(
        'Council',
      );
    }

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await councilSegment.click();
    await expect(councilSegment).toHaveAttribute('aria-checked', 'true');
    const stored = (await rpc.request('threads.get', { id: thread.id })) as {
      executionMode: string;
    };
    expect(stored.executionMode).toBe('council');
  });
});
