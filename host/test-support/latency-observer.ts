export function observerSource(timeoutMs = 15_000): string {
  return `(() => {
    window.__observeRun = ({count,value}) => {
      window.__observation = new Promise((resolve,reject) => {
        let input,handler,command,receiptAt,sentAt,completedAt,renderStart; let renderMs=0; const events = new Map(), eventTimes = new Map(); let finishing = false;
        const priorRender=window.__alderObserveRender, priorSend=WebSocket.prototype.send;
        window.__alderObserveRender=(phase,version)=>{if(phase==='start')renderStart=performance.now();else if(input!==undefined&&renderStart!==undefined)renderMs+=performance.now()-renderStart;priorRender?.(phase,version);};
        WebSocket.prototype.send=function(data){if(input!==undefined&&sentAt===undefined&&typeof data==='string'){try{if(JSON.parse(data)?.command?.type==='run')sentAt=performance.now();}catch{}}return priorSend.call(this,data);};
        const timer = setTimeout(() => finish(new Error('input-to-result timeout: '+JSON.stringify({inputObserved:input!==undefined,commandId:command?.operationId,completed:[...events.keys()],finishing}))),${timeoutMs});
        const click = event => { if(event.target.closest('[data-act=run]')) { if(!event.isTrusted) return finish(new Error('untrusted input')); input=event.timeStamp;handler=performance.now(); } };
        const receipt = event => { if(event.detail.command.type==='run') {command=event.detail.command;receiptAt=performance.now();check();} };
        const unsubscribe = window.__alderHost.client.subscribe((document,event) => {
          if(event?.type==='cell-completed') {events.set(event.cellId,event);eventTimes.set(event.cellId,performance.now());check();}
        });
        function finish(error,result) {clearTimeout(timer);unsubscribe();window.__alderObserveRender=priorRender;WebSocket.prototype.send=priorSend;document.removeEventListener('click',click,true);window.removeEventListener('alder:host-command',receipt);error?reject(error):resolve(result);}
        function check() {
          if(finishing || !command || input===undefined) return;
          const expected = Array.from({length:count},(_,i)=>'cell-'+(i+1));
          if(!expected.every(id=>events.get(id)?.operationId===command.operationId)) return;
          finishing=true;completedAt=performance.now();
          const terminalEventsAt=Math.max(...expected.map(id=>eventTimes.get(id)));
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            try {
              const snapshot=window.__alderHost.client.document.snapshot;
              const root=snapshot.cells.find(cell=>cell.id==='cell-1');
              if(root.body.join('\\n')!=='a <- '+value+'\\na') throw new Error('wrong acknowledged source');
              const runIds=new Set(expected.map(id=>events.get(id).runId));
              if(runIds.size!==1) throw new Error('mixed run identities');
              for(const id of expected) {
                const cell=snapshot.cells.find(cell=>cell.id===id),event=events.get(id);
                const output=document.querySelector('[data-cell="'+id+'"] [data-role=outputs]');
                if(cell.status!=='done'||cell.revision!==event.revision||output?.dataset.runId!==event.runId) throw new Error('stale result');
              }
              const output=document.querySelector('[data-cell="cell-'+count+'"] [data-role=outputs]');
              const expectedText='[1] '+(value+count-1);
              const bounds=output.getBoundingClientRect(),style=getComputedStyle(output);
              if(output.textContent.trim()!==expectedText||bounds.height<=0||bounds.width<=0||bounds.top>=innerHeight||bounds.bottom<=0||bounds.left>=innerWidth||bounds.right<=0||style.visibility==='hidden'||style.display==='none') throw new Error('wrong visible result');
              finish(null,{durationMs:performance.now()-input,inputDelayMs:handler-input,sendDelayMs:sentAt-input,receiptDelayMs:receiptAt-input,commandResponseDelayMs:receiptAt-input,terminalEventsDelayMs:terminalEventsAt-input,completionDelayMs:completedAt-input,presentationMs:performance.now()-completedAt,renderMs,operationId:command.operationId,runId:[...runIds][0],sourceRevision:root.revision,source:root.body,expectedText,events:expected.map(id=>events.get(id))});
            } catch(error){finish(error);}
          }));
        }
        document.addEventListener('click',click,true);window.addEventListener('alder:host-command',receipt);
      });
    };
    window.__observeCreate = () => {
      const before=new Set(window.__alderHost.client.document.cells.map(cell=>cell.key));
      window.__observation=new Promise((resolve,reject)=>{
        let input,handler,frame;let settled=false;
        const timer=setTimeout(()=>finish(new Error('creation timeout')),${timeoutMs});
        const click=event=>{if(event.target.closest('[data-act=add]')){if(!event.isTrusted)return finish(new Error('untrusted input'));input=event.timeStamp;handler=performance.now();frame=requestAnimationFrame(check);}};
        function finish(error,result){if(settled)return;settled=true;if(frame!==undefined)cancelAnimationFrame(frame);clearTimeout(timer);document.removeEventListener('click',click,true);error?reject(error):resolve(result);}
        function check(){
          if(settled)return;
          const cell=window.__alderHost.client.document.cells.find(cell=>!before.has(cell.key));
          const active=document.activeElement;
          if(!cell||!active?.classList.contains('cm-content')||!active.isContentEditable||active.getBoundingClientRect().height<=0||active.closest('[data-key]')?.dataset.key!==cell.key){frame=requestAnimationFrame(check);return;}
          frame=requestAnimationFrame(()=>finish(null,{durationMs:performance.now()-input,inputDelayMs:handler-input,clientOperationId:cell.clientOperationId,notebookCellCount:window.__alderHost.client.document.cells.length,focused:true}));
        }
        document.addEventListener('click',click,true);
      });
    };
  })()`;
}
