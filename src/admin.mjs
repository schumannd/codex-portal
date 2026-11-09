import {openStore} from './store.mjs';
const [command,name]=process.argv.slice(2);
const store=openStore();
try {
  if(command==='create-account') {
    store.createAccount(name);console.log('Account created.');
  }else if(command==='issue-code') {
    const {code}=store.issue(name);console.log(`ONE-TIME DEVICE ENROLLMENT CODE: ${code}\nEXPIRES IN 10 MINUTES. SHARE PRIVATELY WITH THE ACCOUNT OWNER.\nANY PREVIOUS UNUSED CODE FOR THIS ACCOUNT HAS BEEN REVOKED.`);
  }else if(command==='list-accounts') {
    console.table(store.all('SELECT id,name FROM accounts'));
  }else throw Error('Usage: node src/admin.mjs create-account NAME | issue-code NAME | list-accounts');
}catch(e){console.error(e.message);process.exitCode=1;}finally{store.db.close();}
