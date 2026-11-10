import {pbkdf2Sync,createDecipheriv} from 'node:crypto';
import constants from './haltech-constants.json' with {type:'json'};

// Reconstructed from the shipped decoder; these are format constants, not user credentials.
const key=pbkdf2Sync(Buffer.from(constants.password,'hex'),Buffer.from(constants.salt,'hex'),1000,32,'sha1');
export function decryptHaltechContainer(input) {
 const data=Buffer.from(input);
 if(data.length<41) throw new Error('Haltech container is truncated');
 if(!data.subarray(0,5).equals(Buffer.from([72,69,80,83,0]))) throw new Error('Not a Haltech HEPS container');
 if(data.readUInt32LE(5)!==16) throw new Error('Unsupported Haltech IV length');
 if((data.length-25)%16) throw new Error('Invalid Haltech ciphertext length');
 const cipher=createDecipheriv('aes-256-cbc',key,data.subarray(9,25));
 let archive;
 try {archive=Buffer.concat([cipher.update(data.subarray(25)),cipher.final()]);}
 catch {throw new Error('Haltech container decryption failed');}
 if(archive.length<4||archive.readUInt32LE(0)!==0x04034b50) throw new Error('Decrypted Haltech payload is not a ZIP archive');
 return archive;
}
