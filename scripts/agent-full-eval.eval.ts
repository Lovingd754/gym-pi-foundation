import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Socket } from 'node:net';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { resolveAgentModel } from '@/lib/agent/models';
import { createPiFitnessAgentRuntime } from '@/lib/agent/pi-runtime';
import { routeIntent } from '@/lib/agent/intent';
import type { AgentSkill } from '@/lib/agent/skills';
import type { ConversationTurn } from '@/lib/agent/context';
import type { FitnessAgentRunResult } from '@/lib/agent/contracts';
import { createCurrentPlanTool } from '@/lib/agent/tools/current-plan';
import { createRecentTrainingTool } from '@/lib/agent/tools/recent-training';
import { createLogWorkoutTool } from '@/lib/agent/tools/log-workout';
import { createPlanChangeTool } from '@/lib/agent/tools/plan-change';
import { createMemoriesTool, createProposeMemoryTool } from '@/lib/agent/tools/memories';
import type { AgentMemoryStore, AgentMemoryView } from '@/lib/agent/memory-store';
import type { LogProposalEntry, LogProposalStore } from '@/lib/agent/log-proposals';
import type { PlanProposalStore } from '@/lib/agent/plan-proposals';
import type { PlanChange } from '@/lib/fitness/plan-change';
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { createAssessmentInputSchema } from '@/lib/fitness/schemas';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';

// Frozen labels precede execution. Five explicit variants share each base and
// are correlated, not 200 independently sampled real-user requests.
const routeBases: readonly (readonly [string, AgentSkill])[] = [
  ['卧推60公斤8次3组','log'], ['刚做了深蹲，40kg，5次3组','log'],
  ['自重引体向上10个','log'], ['记录俯卧撑3组，每组12次','log'],
  ['Bench Press 60 kg 8 reps 3 sets','log'], ['刚练了高脚杯深蹲24公斤10次2组','log'],
  ['哑铃划船20公斤，每侧8次3组','log'], ['just did five sets of pull-ups','log'],
  ['刚撸完铁，卧推六十公斤，八下，三轮','log'], ['完成了4组，每组10次俯卧撑','log'],
  ['把周三训练挪到周四','plan'], ['有氧减到60分钟','plan'],
  ['高脚杯深蹲换个动作','plan'], ['下周出差，重新安排训练','plan'],
  ['不要安排跑步','plan'], ['今天没时间训练','plan'],
  ['replace workout day with Thursday','plan'], ['去掉这个动作','plan'],
  ['那个动作我不想继续了，能安排别的吗','plan'], ['increase cardio to 90 minutes','plan'],
  ['上周我练了几次？','review'], ['我今天该练什么？','review'],
  ['我每顿应该吃多少？','review'], ['我体重71公斤','review'],
  ['我睡六小时够吗？','review'], ['帮我看看最近的表现','review'],
  ['你还记得我什么？','review'], ['卧推60公斤合适吗？','review'],
  ['最近恢复不过来怎么办？','review'], ['How is my training progress?','review'],
  ['你好','review'], ['谢谢','review'], ['好的','review'], ['hello','review'],
  ['随便聊聊','general'], ['今天天气晴朗','general'], ['你喜欢什么电影','general'],
  ['这是一个测试','general'], ['记住我不喜欢跑步','general'], ['我喜欢早上锻炼','general'],
];
const suffixes = ['', '。', '！', '  ', '\n'];
const routes = routeBases.flatMap(([message, expected], base) => suffixes.map((suffix, variant) => ({ id: `R${base + 1}-${variant + 1}`, base, variant, message: message + suffix, expected })));
type Goal = 'log'|'clarify-log'|'plan-cardio'|'plan-move'|'plan-swap'|'clarify-plan'|'read-plan'|'read-history'|'memory'|'read-memory'|'smalltalk'|'reject-log'|'reject-plan';
interface Case { id: string; base: string; message: string; goal: Goal; weight?: number; reps?: number; sets?: number; minutes?: number; }
function casesFor(v: number): Case[] {
  const weight = 50 + v * 5, reps = 6 + v, minutes = 60 + v * 10;
  const make = (base: string, message: string, goal: Goal, extra: Partial<Case> = {}): Case => ({ id: `S-${base}-${v + 1}`, base, message, goal, ...extra });
  return [
    make('log-cn',`卧推${weight}公斤${reps}次，做了3组`,'log',{weight,reps,sets:3}),
    make('log-en',`I did Bench Press ${weight} kg, ${reps} reps, 2 sets.`,'log',{weight,reps,sets:2}),
    make('log-rir',`刚做了卧推${weight}公斤${reps}次3组，余力2次`,'log',{weight,reps,sets:3}),
    make('log-bodyweight',`记录俯卧撑自重${reps}次3组`,'log',{weight:0,reps,sets:3}),
    make('missing-weight',`刚做了卧推${reps}次3组，重量忘记了`,'clarify-log'),
    make('missing-reps',`卧推${weight}公斤3组，忘了每组次数`,'clarify-log'),
    make('missing-sets',`卧推${weight}公斤${reps}次，组数没告诉你`,'clarify-log'),
    make('cardio',`有氧减到${minutes}分钟`,'plan-cardio',{minutes}),
    make('move','把周三训练挪到周四','plan-move'),
    make('swap','高脚杯深蹲换个动作','plan-swap'),
    make('vague-plan','那个动作我不想继续了，能安排别的吗','clarify-plan'),
    make('plan-read','我今天该练什么？','read-plan'),
    make('nutrition','我每顿应该吃多少？','read-plan'),
    make('history','我最近一次训练练的什么？','read-history'),
    make('memory','记住我不喜欢跑步','memory'),
    make('memory-read','你还记得我什么？','read-memory'),
    make('thanks','谢谢','smalltalk'),
    make('reject-load',`记录卧推3000公斤${reps}次3组`,'reject-log'),
    make('reject-cardio','有氧改成400分钟','reject-plan'),
    make('unknown-exercise',`记录独角兽推举${weight}公斤${reps}次3组`,'reject-log'),
  ];
}
const singles = Array.from({length:5}, (_,v) => casesFor(v)).flat();
interface TurnCase { message: string; goal: Goal; weight?: number; reps?: number; sets?: number; minutes?: number; }
const tasks = Array.from({length:5}, (_,v) => {
  const weight = 50 + v * 5, reps = 6 + v;
  return [
    { id:`M-log-clarify-${v}`, turns:[{message:'刚做了卧推，忘记说重量和次数了',goal:'clarify-log'}, {message:`卧推${weight}公斤${reps}次，做了3组`,goal:'log',weight,reps,sets:3}, {message:`刚才说错了，卧推是${weight+5}公斤${reps}次3组，请重新准备待确认记录`,goal:'log',weight:weight+5,reps,sets:3}] },
    { id:`M-plan-clarify-${v}`, turns:[{message:'那个动作我不想继续了，能安排别的吗',goal:'clarify-plan'}, {message:'高脚杯深蹲换个动作',goal:'plan-swap'}, {message:`有氧减到${60+v*10}分钟`,goal:'plan-cardio',minutes:60+v*10}] },
    { id:`M-plan-correct-${v}`, turns:[{message:'把周三训练挪到周四',goal:'plan-move'}, {message:'先别应用，想看看我目前计划',goal:'read-plan'}, {message:`有氧改成${80+v*10}分钟，只准备待确认提案`,goal:'plan-cardio',minutes:80+v*10}] },
    { id:`M-memory-pending-${v}`, turns:[{message:'记住我不喜欢跑步',goal:'memory'}, {message:'你有哪些已确认的记忆？',goal:'read-memory'}, {message:'谢谢',goal:'smalltalk'}] },
    { id:`M-read-log-${v}`, turns:[{message:'我最近一次训练练的什么？',goal:'read-history'}, {message:`卧推${weight}公斤${reps}次，做了2组`,goal:'log',weight,reps,sets:2}, {message:'我今天该练什么？',goal:'read-plan'}] },
    { id:`M-refuse-recover-${v}`, turns:[{message:'有氧改成400分钟',goal:'reject-plan'}, {message:`有氧改成${70+v*10}分钟`,goal:'plan-cardio',minutes:70+v*10}, {message:'你有哪些已确认的记忆？',goal:'read-memory'}] },
  ] as {id:string;turns:TurnCase[]}[];
}).flat();

describe('full bounded production Agent evaluation', () => {
  it('freezes sample counts and nonempty labels before model execution', () => {
    expect(routes).toHaveLength(200); expect(singles).toHaveLength(100); expect(tasks).toHaveLength(30);
    expect(new Set(routes.map(c => c.id)).size).toBe(200);
    expect(tasks.every(t => t.turns.length === 3)).toBe(true);
  });
  it('runs and saves scored results, including failures', async () => {
    const startedAt = new Date();
    const resolved = await resolveAgentModel();
    if (resolved.model.provider === 'demo-agent') throw new Error('Live model required');
    const now = new Date('2026-09-26T04:00:00Z');
    const assessment = createAssessmentInputSchema(now).parse({
      profile:{ageYears:30,displaySex:'PREFER_NOT_TO_SAY',energyEquationReference:'UNSPECIFIED',heightCm:170,weightKg:82,trainingAgeMonths:3},
      goal:{type:'FAT_LOSS',desiredWeeklyRatePct:-0.5,targetWeightKg:74,targetDate:'2027-03-01'},
      schedule:{weeklyFrequency:3,availableWeekdays:[1,3,5],sessionDurationMin:60,equipmentTypes:['DUMBBELL','BODYWEIGHT'],recentMainLifts:[{catalogKey:'goblet_squat',weightKg:24,reps:10,rir:2}]},
      lifestyle:{activityLevel:'SEDENTARY',avgDailySteps:5000,currentModerateActivityMin:40,habitualSleepMin:380,bedtimeMin:1430,wakeTimeMin:420,timeZone:'Asia/Shanghai'},
      health:{urgentSignals:[],clearanceSignals:[],temporarySignals:[],scopeSignals:[],healthChangedSinceClearance:false,attested:true},
    });
    const content = buildBaselinePlan({assessment,eligibility:evaluateEligibility(assessment,now),gymConstraints:{unavailableExerciseNames:[]},now,loadGuidance:STRENGTH_EXERCISE_CATALOG.map(e=>({catalogKey:e.key,source:'CALIBRATION',initialLoadKg:null}))});
    // TCP only: no authentication, query, table read, or user-data mutation.
    const databaseReachable = await new Promise<boolean>(done => {
      try { const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost:5432'); const socket = new Socket(); socket.setTimeout(1500); const finish=(ok:boolean)=>{socket.destroy();done(ok);}; socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));socket.connect(Number(url.port || 5432),url.hostname); } catch { done(false); }
    });
    type Wire = {stage:string;prompt_tokens:number;completion_tokens:number;prompt_cache_hit_tokens?:number;prompt_cache_miss_tokens?:number;};
    const wire:Wire[]=[]; const agentUsage:FitnessAgentRunResult['usage'][]=[];
    let stage='route'; const nativeFetch=globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response=await nativeFetch(...args);
      if(response.headers.get('content-type')?.includes('application/json')) {
        const body=await response.clone().json().catch(()=>null) as {usage?: Omit<Wire,'stage'>}|null;
        if(body?.usage) wire.push({stage,...body.usage});
      }
      return response;
    };
    // Weekend rates approved for this baseline; peak is exactly double.
    const rates={miss:0.15,hit:0.003,output:0.6};
    const cost=()=>wire.reduce((s,u)=>s+((u.prompt_cache_miss_tokens ?? Math.max(0,u.prompt_tokens-(u.prompt_cache_hit_tokens??0)))*rates.miss+(u.prompt_cache_hit_tokens??0)*rates.hit+u.completion_tokens*rates.output)/1e6,0)+agentUsage.reduce((s,u)=>s+(Math.max(0,u.inputTokens)*rates.miss+u.cachedTokens*rates.hit+u.outputTokens*rates.output)/1e6,0);
    const budget=Number(process.env.AGENT_EVAL_MAX_USD ?? 1);
    const routeResults:unknown[]=[]; const singleResults:unknown[]=[]; const taskResults:unknown[]=[];
    let stoppedForBudget=false;
    const allowed=()=>{if(cost() >= budget-0.01){stoppedForBudget=true;return false;}return true;};
    function fixture() {
      const logs:LogProposalEntry[]=[]; const plans:PlanChange[]=[]; const memories:AgentMemoryView[]=[]; const turns:ConversationTurn[]=[];
      let applied=0;
      const memoryStore:AgentMemoryStore={
        propose:async ({content:note})=>{const id=`memory-${memories.length}`;memories.push({id,content:note,status:'PENDING',createdAt:now});return{id,status:'PENDING',created:true};},
        list:async (_user,status)=>memories.filter(m=>m.status===status),confirm:async()=>{applied++;return false;},dismiss:async()=>false,remove:async()=>false,
      };
      const logStore:LogProposalStore={propose:async ({entry})=>{logs.push(entry);return{id:`log-${logs.length}`};},list:async()=>[],loadPending:async()=>null,markApplied:async()=>{applied++;},dismiss:async()=>false};
      const planStore:PlanProposalStore={propose:async ({change})=>{plans.push(change);return{id:`plan-${plans.length}`,created:true};},list:async()=>[],loadPending:async()=>null,markApplied:async()=>{applied++;},dismiss:async()=>false};
      const scope={userId:'synthetic-eval',locale:'zh-CN'};
      const tools=[
        createCurrentPlanTool(scope,{loadSnapshot:async()=>({version:1,status:'ACTIVE',activatedAt:now,goalType:'FAT_LOSS',desiredWeeklyRatePct:-0.5,timeZone:'Asia/Shanghai',content})},()=>now),
        createRecentTrainingTool(scope,{loadHistory:async()=>({timeZone:'Asia/Shanghai',sessions:[{startedAt:now,finishedAt:new Date(now.getTime()+3600000),workoutName:null,sets:[{weight:60,reps:8,durationSec:null,distanceM:null,isWarmup:false,exercise:{name:'Bench Press',category:'STRENGTH'}}]}]})}),
        createMemoriesTool(scope,memoryStore),createProposeMemoryTool(scope,memoryStore),
        createLogWorkoutTool(scope,{loadExercises:async()=>[{id:'bench',name:'Bench Press'},{id:'pushup',name:'Push-up'}],loadUnit:async()=>'KG'},logStore),
        createPlanChangeTool(scope,{loadActivePlan:async()=>({id:'synthetic-plan',content}),loadConstraints:async()=>({availableWeekdays:[1,2,3,4,5,6,7],equipmentTypes:['DUMBBELL','BODYWEIGHT'],unavailableExerciseNames:[]})},planStore),
      ];
      let calls:{name:string;args:unknown}[]=[];
      const runtime=createPiFitnessAgentRuntime({getModelRequest:async()=>({provider:resolved.model.provider,model:resolved.model.id}),resolveModel:async()=>({model:resolved.model,streamFn:resolved.models.streamSimple.bind(resolved.models) as StreamFn}),loadTurns:async()=>({summary:null,memories:memories.filter(m=>m.status==='ACTIVE').map(m=>m.content),turns}),createTools:()=>tools,routeIntent:(message)=>routeIntent(message),audit:{startRun:async()=>{},configureRun:async()=>{},startTool:async (input)=>{calls.push({name:input.toolName,args:input.args});},finishTool:async()=>{},finishRun:async()=>{}}});
      return {logs,plans,memories,turns,get applied(){return applied;},async run(c:TurnCase) {
        calls=[]; const before={logs:logs.length,plans:plans.length,memories:memories.length}; const start=Date.now();
        const result=await runtime.run({runId:crypto.randomUUID(),kind:'chat',userId:scope.userId,conversationId:'synthetic-thread',locale:scope.locale,message:c.message});
        agentUsage.push(result.usage);
        const newLogs=logs.slice(before.logs),newPlans=plans.slice(before.plans),newMemories=memories.slice(before.memories);
        const names=calls.map(x=>x.name); const text=result.text;
        const errors:string[]=[];const check=(condition:boolean,why:string)=>{if(!condition)errors.push(why);};
        check(result.stopReason==='completed',`stop:${result.stopReason}`);check(text.trim().length>0,'empty-answer');check(applied===0,'unconfirmed-application');check(memories.every(m=>m.status==='PENDING'),'memory-active-without-confirmation');
        const proposal=newLogs.length+newPlans.length+newMemories.length>0;
        if(proposal){check(/确认|待|提案|准备|接受|决定|confirm|propos|pending|accept/i.test(text),'missing-confirmation-language');check(!/(已经|已)(保存|记录|修改|更改|记住)|已帮你记录|successfully (saved|recorded)/i.test(text),'false-applied-claim');}
        switch(c.goal){
          case 'log':check(newLogs.some(e=>e.weight===c.weight&&e.reps===c.reps&&e.sets===c.sets&&e.exerciseId===(c.weight===0?'pushup':'bench')),'log-parameters-or-proposal');break;
          case 'clarify-log':check(newLogs.length===0,'invented-log-facts');check(/[?？]|告诉|多少|重量|次数|组数|补充|提供|确认/i.test(text),'missing-log-clarification');break;
          case 'plan-cardio':check(newPlans.some(p=>p.kind==='SET_CARDIO_MINUTES'&&p.minutes===c.minutes),'cardio-parameter-or-proposal');break;
          case 'plan-move':check(newPlans.some(p=>p.kind==='MOVE_TRAINING_DAY'&&p.from===3&&p.to===4),'weekday-parameter-or-proposal');break;
          case 'plan-swap':check(newPlans.some(p=>p.kind==='SWAP_EXERCISE'&&/goblet squat/i.test(p.from)),'swap-source-or-proposal');break;
          case 'clarify-plan':check(newPlans.length===0,'invented-exercise-reference');check(/[?？]|哪个|具体|告诉|动作名称/i.test(text),'missing-plan-clarification');break;
          case 'read-plan':check(names.includes('get_current_plan'),'plan-not-read');check(/训练|饮食|蛋白|热量|深蹲|分钟|计划|卡路里/i.test(text),'plan-answer-no-domain-facts');break;
          case 'read-history':check(names.includes('get_recent_training'),'history-not-read');check(/60|8|卧推|Bench/i.test(text),'history-answer-missing-fixture-facts');break;
          case 'memory':check(newMemories.some(m=>/跑步|running/i.test(m.content)),'memory-content-or-proposal');break;
          case 'read-memory':check(names.includes('get_memories'),'confirmed-memory-not-read');check(/没有|尚未|还没|暂无|未确认|空|nothing|no .*memor/i.test(text),'pending-treated-as-confirmed');break;
          case 'smalltalk':check(!proposal,'unsolicited-proposal');break;
          case 'reject-log':check(newLogs.length===0,'invalid-log-proposed');break;
          case 'reject-plan':check(newPlans.length===0,'invalid-plan-proposed');break;
        }
        turns.push({role:'user',content:c.message,timestamp:Date.now()},{role:'assistant',content:text,timestamp:Date.now()});
        return{message:c.message,goal:c.goal,passed:errors.length===0,errors,ms:Date.now()-start,result,calls,newLogs,newPlans,newMemories};
      }};
    }
    const folder=resolve('docs/evals');mkdirSync(folder,{recursive:true});
    const save=()=>{
      const passCount=(rows:unknown[])=>rows.filter(r=>(r as {passed:boolean}).passed).length;
      const report={startedAt:startedAt.toISOString(),finishedAt:new Date().toISOString(),elapsedMs:Date.now()-startedAt.getTime(),model:resolved.model.id,provider:resolved.model.provider,databaseReachable,fixture:'synthetic in-memory stores; real production runtime, routing prompt and six tools',planned:{routes:200,singleTurns:100,multiTasks:30,multiTurns:90},completed:{routes:routeResults.length,singleTurns:singleResults.length,multiTasks:taskResults.length},scores:{routes:passCount(routeResults),singleTurns:passCount(singleResults),multiTasks:passCount(taskResults)},budgetUsd:budget,stoppedForBudget,costUsd:cost(),ratesUsdPerMillion:rates,peakCostUsd:cost()*2,wireClassifierUsage:wire,agentUsage,summarizer:{calls:0,tokens:0,reason:'Three-turn tasks do not trigger compaction; no summarizer coverage claimed.'},routes:routeResults,singles:singleResults,tasks:taskResults,limitations:['40 route bases x5 whitespace/punctuation variants, 20 single-turn bases x5 numeric or repeated variants, six task scripts x5 numeric or repeated variants. Correlated variants are not independent real-user samples.','Database persistence, confirmation API/UI, real-user data isolation and new weekly planner are outside this synthetic baseline.','Conversation history reload uses production text-turn semantics without tool transcript persistence.','Cost repriced from wire classifier tokens and streamed Agent usage; configured registry cost is not used. Weekend rates approved for baseline, peak doubled.','Scoring is deterministic and strict; regex-based natural-language checks can have false positives/negatives. Failed cases retained for inspection.']};
      writeFileSync(resolve(folder,'agent-full-eval-results.json'),JSON.stringify(report,null,2));
      const failures=[...singleResults,...taskResults].filter(r=>!(r as {passed:boolean}).passed);
      writeFileSync(resolve(folder,'agent-full-eval-report.md'),`# Full bounded Agent evaluation\n\nModel: ${report.provider}/${report.model}. Elapsed: ${(report.elapsedMs/60000).toFixed(1)} minutes.\n\n| Tier | Passed | Completed | Planned |\n|---|---:|---:|---:|\n| Routing | ${report.scores.routes} | ${routeResults.length} | 200 |\n| Single turn | ${report.scores.singleTurns} | ${singleResults.length} | 100 |\n| Three-turn tasks | ${report.scores.multiTasks} | ${taskResults.length} | 30 |\n\nRepriced weekend cost: $${cost().toFixed(6)}; peak equivalent: $${(cost()*2).toFixed(6)}. Budget: $${budget}; budget stop: ${stoppedForBudget}. Rates per million: miss $0.15, hit $0.003, output $0.60. Source: https://api-docs.deepseek.com/quick_start/pricing .\n\nDatabase TCP reachable: ${databaseReachable}. No database queries or writes were executed. All proposals remain pending.\n\n## Boundaries\n\n${report.limitations.map(x=>'- '+x).join('\n')}\n\nSummarizer: 0 calls and tokens, not exercised.\n\n## Failed Agent cases\n\n\`\`\`json\n${JSON.stringify(failures,null,2)}\n\`\`\`\n`);
      console.log(JSON.stringify({stage:'checkpoint',completed:report.completed,scores:report.scores,costUsd:report.costUsd}));
    };
    try {
      for(const c of routes){if(!allowed())break;const start=Date.now();const actual=await routeIntent(c.message);routeResults.push({...c,actual,passed:actual.skill===c.expected,ms:Date.now()-start});if(routeResults.length%25===0)save();}
      stage='single';
      for(const c of singles){if(!allowed())break;const result=await fixture().run(c);singleResults.push({id:c.id,base:c.base,...result});if(singleResults.length%5===0)save();}
      stage='multi';
      for(const t of tasks){if(!allowed())break;const f=fixture();const results=[];for(const c of t.turns){if(!allowed())break;results.push(await f.run(c));}taskResults.push({id:t.id,passed:results.length===3&&results.every(r=>r.passed),turns:results});save();}
    } finally {globalThis.fetch=nativeFetch;save();}
    // A model-quality failure is a scored result, not a harness crash. Assert
    // completeness separately so a green runner cannot imply model quality.
    expect(routeResults.length+singleResults.length+taskResults.length).toBeGreaterThan(0);
    if(!stoppedForBudget){expect(routeResults).toHaveLength(200);expect(singleResults).toHaveLength(100);expect(taskResults).toHaveLength(30);}
  },7_200_000);
});
