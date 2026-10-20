import { createInterface } from 'node:readline';
const versions=['1.0','1.1','1.2'];
const tools=[{name:'list_releases',description:'List release versions',inputSchema:{type:'object',properties:{},additionalProperties:false}}, {name:'read_release',description:'Read one release and breaking changes',inputSchema:{type:'object',properties:{version:{type:'string'}},required:['version'],additionalProperties:false}}];
for await (const line of createInterface({input:process.stdin})) {
 let r;try{r=JSON.parse(line);}catch{continue;}
 if(r.id===undefined)continue;
 let result;
 if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'mock-docs',version:'1'},instructions:'Read-only release evidence. Return structuredContent; missing versions are tool errors.'};
 else if(r.method==='tools/list')result={tools};
 else if(r.method==='tools/call'){
 const v=r.params.arguments?.version;
 const value=r.params.name==='list_releases'?{versions}:versions.includes(v)?{version:v,breaking:v==='1.1'?['rename retryLimit to retries']:[],evidence:`Release ${v}: verified fixture line\n`+'detail '.repeat(5000)}:null;
 result=value?{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}:{content:[{type:'text',text:'version not found'}],isError:true};
 }else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
}
