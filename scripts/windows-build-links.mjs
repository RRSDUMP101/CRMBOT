// Local build helper only. Never imported by the Worker.
// pnpm junctions are absolute on Windows; copied links must follow the copied
// packages that OpenNext patches, rather than the original node_modules tree.
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';

if(process.platform==='win32'){
  const original=fs.symlinkSync;
  fs.symlinkSync=function(target,destination,type){
    const project=process.cwd(),link=path.resolve(String(destination));
    let resolved=path.isAbsolute(String(target))?String(target):path.resolve(path.dirname(link),String(target));
    const sourceTarget=resolved;
    const roots=[path.join(project,'.next','standalone'),path.join(project,'.open-next','server-functions','default')];
    const copyRoot=roots.find(root=>link.startsWith(root+path.sep));
    if(copyRoot){
      const sourceRoots=[path.join(project,'node_modules'),path.join(project,'.next','standalone','node_modules')];
      const sourceRoot=sourceRoots.find(root=>resolved.startsWith(root+path.sep));
      if(sourceRoot)resolved=path.join(copyRoot,'node_modules',path.relative(sourceRoot,resolved));
    }
    let directory=type==='dir'||type==='junction';
    try{directory=fs.statSync(sourceTarget).isDirectory();}catch(error){
      if(error.code!=='ENOENT')throw error;
      // A traced directory can be copied later in the same pass. Probe its
      // original package without changing where the output junction points.
      const copiedModules=copyRoot&&path.join(copyRoot,'node_modules');
      if(copiedModules&&resolved.startsWith(copiedModules+path.sep)){
        try{directory=fs.statSync(path.join(project,'node_modules',path.relative(copiedModules,resolved))).isDirectory();}catch{}
      }
    }
    return directory?original.call(fs,resolved,destination,'junction'):original.call(fs,target,destination,type);
  };
  syncBuiltinESMExports();
}
