import { register } from 'tsx/esm/api';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

register();
const { Chrome, resolveChromeExecutable } = await import('./chrome.ts');

/**
 * Start the canonical Chromium driver before the host is launched. Call
 * driver.navigate(harness) after the staged host publishes its origin.
 */
export async function prewarmInteractiveBrowser({ evidence, name = 'browser' } = {}) {
  const previous = process.env.CHROME_BIN;
  const previousPath = process.env.CHROME_PATH;
  try {
    const executable = await resolveChromeExecutable();
    process.env.CHROME_BIN = executable;
    process.env.CHROME_PATH = executable;
    const browser = await Chrome.open('about:blank');
    return createDriver(browser, { evidence, name });
  } catch (error) {
    const unavailable = new Error('browser_unavailable: ' + String(error?.message ?? error));
    unavailable.code = 'scenario_unavailable';
    throw unavailable;
  } finally {
    if (previous === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = previous;
    if (previousPath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = previousPath;
  }
}
/** Open a canonical Chromium tab for an already-started staged host. */
export async function openInteractiveBrowser(harness, options = {}) {
  let driver;
  try {
    driver = await prewarmInteractiveBrowser(options);
    await driver.navigate(harness);
    return driver;
  } catch (error) {
    await driver?.close().catch(() => {});
    throw error;
  }
}
function createDriver(browser, { evidence, name }) {
  return {
    browser,
    cdpEndpoint: browser.cdpEndpoint,
    chromePid: browser.pid,
    async navigate(harness) {
      const ticket = await harness.mintTicket();
      await browser.send('Page.navigate', { url: harness.origin + '/#ticket=' + encodeURIComponent(ticket) });
    },
    async observe(label = 'state') {
      const state = await visiblePageState(browser);
      let screenshot;
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true });
        const capture = await browser.send('Page.captureScreenshot', { format: 'png' });
        screenshot = join(evidence, name + '-' + label + '.png');
        await writeFile(screenshot, Buffer.from(capture.data, 'base64'));
      }
      return { state, screenshot };
    },
    async replaceEditor(selector, text) {
      await browser.click(selector);
      await replaceFocusedEditor(browser, text);
    },
    async wait(expression, timeout = 15_000) { return browser.wait(expression, timeout); },
    async click(selector) { return browser.click(selector); },
    async close() { await browser.close(); },
  };
}

export async function visiblePageState(browser) {
  const expression = [
    '(() => {',
    '  const visible = element => {',
    '    if (!element) return false;',
    '    const rect = element.getBoundingClientRect();',
    '    const style = getComputedStyle(element);',
    "    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';",
    '  };',
    "  const text = element => element?.innerText ?? element?.textContent ?? '';",
    "  const cells = [...document.querySelectorAll('#notebook > .cell[data-cell]')].filter(visible).map(cell => ({",
    '    id: cell.dataset.cell,',
    "    source: text(cell.querySelector('.cm-content')),",
    "    output: text(cell.querySelector('[data-role=outputs]')),",
    "    running: cell.classList.contains('running'),",
    '  }));',
    '  return {',
    '    url: location.href,',
    '    title: document.title,',
    '    ready: window.__alderHost?.client?.document?.snapshot?.runtime?.executionReady === true,',
    '    busy: window.__alderHost?.client?.document?.snapshot?.runtime?.busy === true,',
    "    controls: Object.fromEntries(['notebook', 'save', 'run-all', 'stop', 'settings'].map(id => [id, visible(document.querySelector('#' + id))])),",
    '    source: cells.map(cell => cell.source).filter(Boolean).join(String.fromCharCode(10)),',
    '    cells,',
    "    text: text(document.querySelector('#notebook')),",
    '  };',
    '})()',
  ].join(String.fromCharCode(10));
  return browser.evaluate(expression);
}

async function replaceFocusedEditor(browser, text) {
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  });
  await browser.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2,
  });
  await browser.send('Input.insertText', { text });
}
