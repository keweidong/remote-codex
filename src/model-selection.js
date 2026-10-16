import {error} from './auth.js';

export function modelSelection({model,effort}={}) {
  const result={};
  for(const [key,value] of Object.entries({model,effort})) {
    if(value===undefined||value==='')continue;
    if(typeof value!=='string'||value.length>128||!value.trim())throw error('模型或推理强度格式无效。');
    result[key]=value;
  }
  return result;
}
export function selectionSuffix(selection) {
  return Object.keys(selection).length ? '\n'+JSON.stringify({model:selection.model||'',effort:selection.effort||''}) : '';
}
