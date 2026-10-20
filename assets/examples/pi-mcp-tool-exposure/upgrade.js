const found = await searchTools('release', { namespace:'docs' });
text({found:found.map(x=>x.name)});
text(await describeTool('mcp__docs__read_release'));
const index = await tools.mcp__docs__list_releases({});
const versions = [...index.structuredContent.versions, 'missing'];
const rows = await Promise.allSettled(versions.map(version => tools.mcp__docs__read_release({version})));
return rows.map((r,i)=> r.status==='rejected' ? {version:versions[i],status:'rejected'} : r.value.isError ? {version:versions[i],status:'tool_error'} : {version:versions[i],breaking:r.value.structuredContent.breaking,evidence:r.value.structuredContent.evidence.slice(0,35)});
