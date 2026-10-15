import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';

export function readPrivateIcon(directory,filename) {
  if (typeof directory!=='string'||typeof filename!=='string'||! /^[a-z0-9][a-z0-9-]{0,79}\.(png|ico|webp)$/.test(filename)) return null;
  try {
    const root=realpathSync(directory),path=realpathSync(resolve(root,filename));
    if (!path.startsWith(root+sep)) return null;
    const stat=statSync(path);if(!stat.isFile()||stat.size<16||stat.size>512*1024)return null;
    const data=readFileSync(path),extension=extname(filename);
    const valid=extension==='.png'?data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
      extension==='.webp'?data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP':
      data.readUInt32LE(0)===65536&&data.readUInt16LE(4)>0;
    if(!valid)return null;
    return {data,type:{'.png':'image/png','.ico':'image/x-icon','.webp':'image/webp'}[extension]};
  } catch {return null;}
}
