import { it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLlmProviderFor } from '@/lib/llm/settings';
import { requestWeeklyStrategy, parseWeeklyStrategy } from '@/lib/fitness/weekly-strategy';
import { extractStrategyJson } from '@/lib/fitness/plan-strategy';
import { applyWeeklyStrategy } from '@/lib/fitness/weekly-strategy-apply';
import { requestDetailedStrength } from '@/lib/fitness/detailed-strength';
import { buildBaselinePlan } from '@/lib/fitness/baseline-plan';
import { evaluateEligibility } from '@/lib/fitness/eligibility';
import { createAssessmentInputSchema } from '@/lib/fitness/schemas';
import { STRENGTH_EXERCISE_CATALOG } from '@/lib/fitness/exercise-catalog';

it('separately smokes two live weekly strategies on synthetic evidence', async () => {
  const now = new Date('2026-09-26T04:00:00Z');
  const assessment = createAssessmentInputSchema(now).parse({
    profile:{ageYears:30,displaySex:'PREFER_NOT_TO_SAY',energyEquationReference:'UNSPECIFIED',heightCm:170,weightKg:82,trainingAgeMonths:3},
    goal:{type:'FAT_LOSS',desiredWeeklyRatePct:-0.5,targetWeightKg:74,targetDate:'2027-03-01'},
    schedule:{weeklyFrequency:3,availableWeekdays:[1,3,5],sessionDurationMin:60,equipmentTypes:['DUMBBELL','BODYWEIGHT'],recentMainLifts:[{catalogKey:'goblet_squat',weightKg:24,reps:10,rir:2}]},
    lifestyle:{activityLevel:'SEDENTARY',avgDailySteps:5000,currentModerateActivityMin:40,habitualSleepMin:380,bedtimeMin:1430,wakeTimeMin:420,timeZone:'Asia/Shanghai'},
    health:{urgentSignals:[],clearanceSignals:[],temporarySignals:[],scopeSignals:[],healthChangedSinceClearance:false,attested:true},
  });
  const input={assessment,eligibility:evaluateEligibility(assessment,now),gymConstraints:{unavailableExerciseNames:[]},now,loadGuidance:STRENGTH_EXERCISE_CATALOG.map(e=>({catalogKey:e.key,source:'CALIBRATION' as const,initialLoadKg:null}))};
  const previousPlan=buildBaselinePlan(input);
  const provider=await getLlmProviderFor();
  if(!provider.isConfigured()||provider.id==='demo')throw new Error('Live configured provider required');
  const scenarios=[
    {id:'travel-recovery',constraints:{availableWeekdays:[1,4],equipmentTypes:['DUMBBELL','BODYWEIGHT'] as ('DUMBBELL'|'BODYWEIGHT')[],sessionDurationMin:45},context:{previousPlan,completion:{planned:3,completed:2},recovery:{sleepAverageHours:5.5,fatigue:'HIGH'},activities:[{description:'Business trip Tuesday and Wednesday, hotel dumbbells, 45 minutes on Monday and Thursday'}],activeMemories:['Prefers dumbbells'],load:{lastBenchKg:60,reps:8}}},
    {id:'no-evidence',constraints:{availableWeekdays:[1,3,5],equipmentTypes:['DUMBBELL','BODYWEIGHT'] as ('DUMBBELL'|'BODYWEIGHT')[],sessionDurationMin:60},context:{previousPlan:null,completion:[],body:[],load:[],recovery:[],activeMemories:[],activities:[{description:'Available Monday Wednesday Friday, 60 minutes, dumbbells and bodyweight'}]}},
  ];
  const nativeFetch=globalThis.fetch;
  const wire:Record<string,number>[]=[];
  globalThis.fetch=async(...args)=>{const response=await nativeFetch(...args);if(response.headers.get('content-type')?.includes('application/json')){const body=await response.clone().json().catch(()=>null);if(body?.usage)wire.push(body.usage);}return response;};
  const results:unknown[]=[];const started=Date.now();
  try{
    for(const scenario of scenarios){
      const start=Date.now();
      let rawText='';
      try{
        const strategy=await requestWeeklyStrategy({userId:'synthetic-weekly',context:scenario.context,constraints:scenario.constraints},{complete:async({system,messages,thinking})=>{rawText=(await provider.complete({system,messages,maxTokens:3000,thinking})).text;return rawText;}});
        const applied=applyWeeklyStrategy(input,strategy,scenario.constraints);
        if(process.env.DETAILED_STRENGTH_SMOKE==='true') applied.content=await requestDetailedStrength({userId:'synthetic-weekly',base:applied.content,calculation:input,strategy,constraints:scenario.constraints,context:scenario.context},{complete:async({system,messages,thinking})=>(await provider.complete({system,messages,maxTokens:5000,thinking})).text});
        const errors:string[]=[];
        if(!applied.content.strength.days.every(d=>typeof d.dayOfWeek==='number'&&scenario.constraints.availableWeekdays.includes(d.dayOfWeek)))errors.push('strength-unavailable-day');
        if(!applied.content.cardio.sessions.every(s=>scenario.constraints.availableWeekdays.includes(s.dayOfWeek)))errors.push('cardio-unavailable-day');
        if(!applied.content.strength.days.every(d=>d.estimatedDurationMin<=scenario.constraints.sessionDurationMin))errors.push('duration-exceeded');
        if(scenario.id==='travel-recovery'&&strategy.recovery!=='REDUCED')errors.push('did-not-reduce-recovery');
        if(scenario.id==='travel-recovery'&&strategy.cardioPreference==='MORE')errors.push('increased-cardio-despite-fatigue');
        if(scenario.id==='no-evidence'&&!/uncertain|missing|absen|limited|no .*data|no .*evidence|without|lack|未知|缺|没有|不足|不确定/i.test(strategy.rationale??''))errors.push('did-not-explain-uncertainty');
        results.push({id:scenario.id,passed:errors.length===0,errors,ms:Date.now()-start,strategy,generated:{weekdays:applied.content.strength.days.map(d=>d.dayOfWeek),durations:applied.content.strength.days.map(d=>d.estimatedDurationMin),cardioMinutes:applied.content.cardio.additionalWeeklyMin}});
      }catch(error){
        let parserCause='';try{parseWeeklyStrategy(extractStrategyJson(rawText),scenario.constraints);}catch(cause){parserCause=cause instanceof Error?cause.message:'UNKNOWN';}
        results.push({id:scenario.id,passed:false,error:error instanceof Error?error.message:'UNKNOWN',parserCause,rawText,ms:Date.now()-start});
      }
    }
  }finally{globalThis.fetch=nativeFetch;}
  const costUsd=wire.reduce((s,u)=>s+((u.prompt_cache_miss_tokens??Math.max(0,(u.prompt_tokens??0)-(u.prompt_cache_hit_tokens??0)))*0.15+(u.prompt_cache_hit_tokens??0)*0.003+(u.completion_tokens??0)*0.6)/1e6,0);
  const report={separateFromBaseline:true,provider:provider.id,model:provider.model,completed:results.length,passed:results.filter(r=>(r as {passed:boolean}).passed).length,elapsedMs:Date.now()-started,costUsd,wireUsage:wire,results,limitations:['Two synthetic smoke cases, not statistical quality validation.','No DB, persistence, API, confirmation UI or summarizer coverage.','Actual production weekly prompt, parser and deterministic plan application used.']};
  const folder=resolve(process.env.DETAILED_STRENGTH_SMOKE==='true'?'docs/evals/detailed-strength':'docs/evals');mkdirSync(folder,{recursive:true});
  const historyPath=resolve(folder,'weekly-strategy-live-smoke-history.json');
  const history:{costUsd:number;passed:number;completed:number}[]=existsSync(historyPath)?JSON.parse(readFileSync(historyPath,'utf8')):[];
  if(history.length===0){for(const name of ['weekly-strategy-initial-failure.json','weekly-strategy-live-smoke-results.json']){const path=resolve(folder,name);if(existsSync(path))history.push(JSON.parse(readFileSync(path,'utf8')));}}
  history.push(report);writeFileSync(historyPath,JSON.stringify(history,null,2));
  const cumulativeCostUsd=history.reduce((sum,attempt)=>sum+attempt.costUsd,0);
  writeFileSync(resolve(folder,'weekly-strategy-live-smoke-results.json'),JSON.stringify({...report,attempts:history.length,cumulativeCostUsd},null,2));
  writeFileSync(resolve(folder,'weekly-strategy-live-smoke-report.md'),`# Separate live weekly strategy smoke\n\nLatest: ${report.passed}/${report.completed} passed. Model ${report.provider}/${report.model}. Latest cost $${costUsd.toFixed(6)}. Total smoke spend across ${history.length} attempts: $${cumulativeCostUsd.toFixed(6)}. These cases are outside the 200/100/30 baseline.\n\nEarlier attempts (preserved in history JSON): ${history.slice(0,-1).map((attempt,i)=>`attempt ${i+1}: ${attempt.passed}/${attempt.completed}, $${attempt.costUsd.toFixed(6)}`).join('; ')}.\n\n\`\`\`json\n${JSON.stringify(report,null,2)}\n\`\`\`\n`);
  console.log(JSON.stringify({stage:'weekly-live-smoke',passed:report.passed,completed:report.completed,costUsd}));
  expect(results).toHaveLength(2);
},180_000);
