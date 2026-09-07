import test from 'node:test';
import assert from 'node:assert/strict';
import { Chrome } from '../test-support/chrome.js';
import { observerSource } from '../test-support/latency-observer.js';

test('visible-result observer rejects stale identities, wrong DOM values, and untrusted input', {
  skip: process.env.ALDER_BROWSER_TEST !== '1', timeout: 60_000,
}, async () => {
  const browser = await Chrome.open('data:text/html,<button data-act="run">Run</button><div data-cell="cell-1"><div data-role="outputs">[1] 1</div></div>');
  try {
    await browser.wait('document.querySelector("button") !== null');
    await browser.evaluate(`window.__clicks=[];document.addEventListener('click',event=>window.__clicks.push({trusted:event.isTrusted,target:event.target.outerHTML}));window.__alderHost={client:{document:{snapshot:{cells:[{id:'cell-1',body:['a <- 1','a'],revision:1,status:'done'}]}},subscribe(listener){window.__subscriber=listener;return()=>{};}}};
      document.querySelector('[data-role=outputs]').dataset.runId='run-current';`);
    await browser.evaluate(observerSource(5000));
    for (const responseFirst of [true, false]) {
      await browser.evaluate(`window.__observeRun({count:1,value:1});void 0;`);
      await browser.click('[data-act=run]');
      await browser.evaluate(`{
        const response=()=>window.dispatchEvent(new CustomEvent('alder:host-command',{detail:{command:{type:'run',operationId:'op-current'}}}));
        const terminal=()=>window.__subscriber(window.__alderHost.client.document,{type:'cell-completed',cellId:'cell-1',revision:1,runId:'run-current',operationId:'op-current'});
        (${responseFirst ? 'response' : 'terminal'})();setTimeout(${responseFirst ? 'terminal' : 'response'},20);
      }`);
      const sample = await browser.evaluate('window.__observation');
      assert.equal(sample.receiptDelayMs, sample.commandResponseDelayMs);
      assert.equal(sample.commandResponseDelayMs < sample.terminalEventsDelayMs, responseFirst);
      assert.ok(sample.completionDelayMs >= Math.max(sample.commandResponseDelayMs, sample.terminalEventsDelayMs));
      assert.ok(sample.durationMs >= sample.completionDelayMs);
    }
    for (const mode of ['stale', 'wrong-output', 'untrusted']) {
      await browser.evaluate(`window.__observeRun({count:1,value:1});window.__observation=window.__observation.then(()=>({passed:true}),error=>({error:error.message}));void 0;`);
      if (mode === 'untrusted') await browser.evaluate('document.querySelector("button").click()');
      else await browser.click('[data-act=run]');
      await browser.evaluate(`window.dispatchEvent(new CustomEvent('alder:host-command',{detail:{command:{type:'run',operationId:'op-current'}}}));
        document.querySelector('[data-role=outputs]').textContent=${JSON.stringify(mode === 'wrong-output' ? '[1] 999' : '[1] 1')};
        window.__subscriber(window.__alderHost.client.document,{type:'cell-completed',cellId:'cell-1',revision:1,runId:'run-current',operationId:${JSON.stringify(mode === 'stale' ? 'op-old' : 'op-current')}});`);
      const outcome = await browser.evaluate('window.__observation');
      assert.equal(outcome.passed, undefined);
      assert.match(outcome.error, mode === 'stale' ? /timeout/ : mode === 'wrong-output' ? /wrong visible result/ : /untrusted input/,
        JSON.stringify(await browser.evaluate('({clicks:window.__clicks,visibility:document.visibilityState,html:document.body.innerHTML})')));
    }
    await browser.evaluate(`window.__alderHost.client.document.cells=[];document.querySelector('button').dataset.act='add';window.__frames=0;window.__originalFrame=requestAnimationFrame;window.requestAnimationFrame=callback=>{window.__frames++;return window.__originalFrame(callback);};`);
    await browser.evaluate(observerSource(500));
    await browser.evaluate(`window.__observeCreate();window.__observation=window.__observation.catch(error=>({error:error.message}));void 0;`);
    await browser.click('[data-act=add]');
    assert.match((await browser.evaluate('window.__observation')).error, /creation timeout/);
    const frameCount = await browser.evaluate('window.__frames');
    assert.ok(frameCount > 1, 'creation check must have retried before timeout');
    await browser.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
    assert.equal(await browser.evaluate('window.__frames'), frameCount, 'timed-out creation must stop scheduling frames');
  } finally { await browser.close(); }
});
