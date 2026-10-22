export function appServerFixture({source = "vscode", failTurn = false, complete = false, turnStatus = "inProgress", completeBeforeReply = false} = {}) {
  return `
const fs = require("node:fs");
const options = ${JSON.stringify({source, failTurn, complete, turnStatus, completeBeforeReply})};
fs.appendFileSync("calls.txt", "spawn\\n");
fs.writeFileSync("launch.json", JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(2)}));
const requests=[];
let active = options.turnStatus === "inProgress";
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const req=JSON.parse(line);
  requests.push(req);
  fs.writeFileSync("requests.json",JSON.stringify(requests));
  const respond = result => console.log(JSON.stringify({id:req.id,result}));
  if(req.method==="initialize") respond({});
  if(req.method==="thread/start") respond({thread:{id:"new-session",source:options.source,projectId:req.params.projectId,ephemeral:false}});
  if(req.method==="thread/read") respond({thread:{id:req.params.threadId,status:{type:active?"active":"idle"},canAcceptDirectInput:true}});
  if(req.method==="thread/turns/list") respond({data:[{id:"first-turn",status:active?"inProgress":"completed",items:[]}],nextCursor:null});
  if(req.method==="thread/read") respond({thread:{id:req.params.threadId,status:{type:active?"active":"idle"},canAcceptDirectInput:true}});
  if(req.method==="thread/queue/list") respond({data:[],nextCursor:null});
  if(req.method==="turn/steer") respond({turnId:req.params.expectedTurnId});
  if(req.method==="turn/interrupt") {
    active=false;
    console.log(JSON.stringify({method:"turn/completed",params:{threadId:req.params.threadId,turn:{id:req.params.turnId,status:"interrupted"}}}));
    respond({});
  }
  if(req.method==="turn/start") {
    if(options.failTurn) console.log(JSON.stringify({id:req.id,error:{code:-32000,message:"fixture turn failed"}}));
    else {
      if(options.completeBeforeReply)console.log(JSON.stringify({method:"turn/completed",params:{threadId:req.params.threadId,turn:{id:"first-turn",status:"completed"}}}));
      respond({turn:{id:"first-turn",status:options.turnStatus}});
      if(options.complete) setTimeout(()=>console.log(JSON.stringify({method:"turn/completed",params:{threadId:req.params.threadId,turn:{id:"first-turn",status:"completed"}}})),20);
    }
  }
});
`;
}
