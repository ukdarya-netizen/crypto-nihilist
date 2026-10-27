import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicates } from "./dedupe";
const d=(h:number)=>new Date(Date.UTC(2026,9,20,h));
test("dups",()=>{
  const r=findDuplicates([
    {id:1,symbol:"ETHFI",setup:"4h_30m",side:"long",opened_at:d(1),closed_at:null},
    {id:2,symbol:"ETHFI",setup:"4h_1h",side:"long",opened_at:d(1),closed_at:null},
    {id:3,symbol:"A",setup:"x",side:"long",opened_at:d(1),closed_at:d(5)},
    {id:4,symbol:"A",setup:"y",side:"long",opened_at:d(3),closed_at:d(9)},
    {id:5,symbol:"A",setup:"z",side:"long",opened_at:d(6),closed_at:null},
    {id:6,symbol:"A",setup:"z",side:"short",opened_at:d(3),closed_at:null},
  ]);
  assert.deepEqual(r.map(x=>[x.id,x.kept_id]),[[2,1],[4,3]]);
});
