// 催眠手机（/api/hypnosis）单独作为默认导出，供 app.js 按文件挂载追溯（见 test/godSaysAcceptanceHttp.test.js）。
export { phoneRouter as default } from './hypnosis.js';
