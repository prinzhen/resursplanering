import assert from "node:assert/strict";
import {filterChefEmployees} from "../lib/chef-filter.ts";

const employees=[
 {id:1,name:"Chef A",managerId:null},
 {id:2,name:"Person A1",managerId:1},
 {id:3,name:"Person A2",managerId:1},
 {id:4,name:"Chef B",managerId:null},
 {id:5,name:"Person B1",managerId:4},
 {id:6,name:"Fristående",managerId:null}
];
const memberships=[
 {groupId:10,employeeId:2},
 {groupId:10,employeeId:5},
 {groupId:11,employeeId:3},
 {groupId:10,employeeId:999}
];
const ids=(scope,people=employees)=>filterChefEmployees(people,memberships,scope).map(x=>x.id);
assert.deepEqual(ids("all"),[1,2,3,4,5,6]);
assert.deepEqual(ids("group:1"),[1,2,3]);
assert.deepEqual(ids("group:4"),[4,5]);
assert.deepEqual(ids("team:10"),[2,5]);
assert.deepEqual(ids("team:11"),[3]);
assert.deepEqual(ids("person:6"),[6]);
assert.deepEqual(ids("person:2"),[2]);
assert.deepEqual(ids("team:100"),[]);
assert.deepEqual(ids("group:999"),[]);
assert.deepEqual(ids("person:0"),[]);
assert.deepEqual(ids("something:1"),[]);
assert.deepEqual(ids("team:10",[employees[1]]),[2],"Never expose an employee excluded by auth scope");
console.log("PASS chef-view filters: GRUPP, TEAM, individual and access-scoped employee list");
