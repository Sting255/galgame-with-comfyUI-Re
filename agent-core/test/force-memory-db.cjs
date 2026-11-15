'use strict';

// 必须由 node --require 在任何测试文件及其静态导入之前加载。
// 测试永远使用独立内存库，外部 shell 即使设置了真实 DB_PATH 也不能覆盖这条安全边界。
process.env.DB_PATH = ':memory:';
