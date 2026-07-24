async function initDatabase(config) {
  console.log("开始数据库初始化...");
  if (!config || !config.database) {
    console.error("数据库配置缺失");
    throw new Error("数据库配置无效，请检查D1数据库是否正确绑定");
  }
  if (!config.fileCache) {
    config.fileCache = new Map();
    config.fileCacheTTL = 3600000;
  }
  const maxRetries = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`正在测试数据库连接... (尝试 ${attempt}/${maxRetries})`);
      await config.database.prepare("SELECT 1").run();
      console.log("数据库连接成功");
      console.log("正在验证数据库结构...");
      const structureValid = await validateDatabaseStructure(config);
      if (!structureValid) {
        throw new Error("数据库结构验证失败");
      }
      console.log("数据库初始化成功");
      return true;
    } catch (error) {
      lastError = error;
      console.error(`数据库初始化尝试 ${attempt} 失败:`, error);
      if (error.message.includes('no such table')) {
        console.log("检测到数据表不存在，尝试创建...");
        try {
          await recreateAllTables(config);
          console.log("数据表创建成功");
          return true;
        } catch (tableError) {
          console.error("创建数据表失败:", tableError);
        }
      }
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw new Error(`数据库初始化失败 (${maxRetries} 次尝试): ${lastError?.message || '未知错误'}`);
}
async function recreateAllTables(config) {
  try {
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'telegram',
        current_category_id INTEGER,
        waiting_for TEXT,
        editing_file_id TEXT,
        is_processing INTEGER DEFAULT 0,
        lock_time INTEGER,
        upload_seq INTEGER DEFAULT 0,
        FOREIGN KEY (current_category_id) REFERENCES categories(id)
      )
    `).run();

    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        added_by TEXT,
        created_at INTEGER NOT NULL
      )
    `).run();

    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT,
        message_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        storage_type TEXT DEFAULT 'telegram',
        category_id INTEGER,
        chat_id TEXT,
        custom_suffix TEXT,
        is_chunked INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        upload_id TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();

    // 分片先以 upload_id 暂存；完成后再绑定 files.id
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS file_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upload_id TEXT NOT NULL,
        file_id INTEGER,
        chat_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        total_chunks INTEGER NOT NULL,
        telegram_file_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(upload_id, chunk_index),
        FOREIGN KEY (file_id) REFERENCES files(id)
      )
    `).run();

    // 机器人“上传大文件”按钮生成的一次性网页会话
    // expires_at 只限制尚未开始的会话；首片上传成功后即使超时也允许继续完成
    await config.database.prepare(`
      CREATE TABLE IF NOT EXISTS bot_upload_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        upload_id TEXT NOT NULL UNIQUE,
        category_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        total_chunks INTEGER NOT NULL DEFAULT 0,
        uploaded_chunks INTEGER NOT NULL DEFAULT 0,
        uploaded_bytes INTEGER NOT NULL DEFAULT 0,
        result_file_id INTEGER,
        result_url TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        FOREIGN KEY (result_file_id) REFERENCES files(id)
      )
    `).run();

    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id
      ON file_chunks(file_id, chunk_index)
    `).run();

    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_file_chunks_upload_id
      ON file_chunks(upload_id, chunk_index)
    `).run();

    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_upload_sessions_chat_status
      ON bot_upload_sessions(chat_id, status, created_at)
    `).run();

    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_upload_sessions_expires
      ON bot_upload_sessions(expires_at, status)
    `).run();

    await config.database.prepare(`
      INSERT OR IGNORE INTO categories (name) VALUES ('默认分类')
    `).run();

    return true;
  } catch (error) {
    console.error("重新创建表失败:", error);
    throw error;
  }
}
async function validateDatabaseStructure(config) {
  try {
    const tables = [
      'categories',
      'user_settings',
      'allowed_users',
      'files',
      'file_chunks',
      'bot_upload_sessions'
    ];
    for (const table of tables) {
      try {
        await config.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).run();
      } catch (error) {
        if (error.message.includes('no such table')) {
          console.log(`表 ${table} 不存在，尝试重新创建所有表...`);
          await recreateAllTables(config);
          continue;
        }
        throw error;
      }
    }
    const tableStructures = {
      categories: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
        { name: 'created_at', type: 'DATETIME' }
      ],
      user_settings: [
        { name: 'id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'storage_type', type: 'TEXT' },
        { name: 'current_category_id', type: 'INTEGER' },
        { name: 'waiting_for', type: 'TEXT' },
        { name: 'editing_file_id', type: 'TEXT' },
        { name: 'is_processing', type: 'INTEGER' },
        { name: 'lock_time', type: 'INTEGER' },
        { name: 'upload_seq', type: 'INTEGER' }
      ],
      allowed_users: [
        { name: 'id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'added_by', type: 'TEXT' },
        { name: 'created_at', type: 'INTEGER' }
      ],
      files: [
        { name: 'id', type: 'INTEGER' },
        { name: 'url', type: 'TEXT' },
        { name: 'fileId', type: 'TEXT' },
        { name: 'message_id', type: 'INTEGER' },
        { name: 'created_at', type: 'DATETIME' },
        { name: 'file_name', type: 'TEXT' },
        { name: 'file_size', type: 'INTEGER' },
        { name: 'mime_type', type: 'TEXT' },
        { name: 'storage_type', type: 'TEXT' },
        { name: 'category_id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'custom_suffix', type: 'TEXT' },
        { name: 'is_chunked', type: 'INTEGER' },
        { name: 'chunk_count', type: 'INTEGER' },
        { name: 'upload_id', type: 'TEXT' }
      ],
      file_chunks: [
        { name: 'id', type: 'INTEGER' },
        { name: 'upload_id', type: 'TEXT' },
        { name: 'file_id', type: 'INTEGER' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'chunk_index', type: 'INTEGER' },
        { name: 'total_chunks', type: 'INTEGER' },
        { name: 'telegram_file_id', type: 'TEXT' },
        { name: 'message_id', type: 'INTEGER' },
        { name: 'chunk_size', type: 'INTEGER' },
        { name: 'created_at', type: 'INTEGER' }
      ],
      bot_upload_sessions: [
        { name: 'id', type: 'INTEGER' },
        { name: 'token_hash', type: 'TEXT' },
        { name: 'chat_id', type: 'TEXT' },
        { name: 'upload_id', type: 'TEXT' },
        { name: 'category_id', type: 'INTEGER' },
        { name: 'status', type: 'TEXT' },
        { name: 'file_name', type: 'TEXT' },
        { name: 'file_size', type: 'INTEGER' },
        { name: 'mime_type', type: 'TEXT' },
        { name: 'total_chunks', type: 'INTEGER' },
        { name: 'uploaded_chunks', type: 'INTEGER' },
        { name: 'uploaded_bytes', type: 'INTEGER' },
        { name: 'result_file_id', type: 'INTEGER' },
        { name: 'result_url', type: 'TEXT' },
        { name: 'error_message', type: 'TEXT' },
        { name: 'created_at', type: 'INTEGER' },
        { name: 'expires_at', type: 'INTEGER' },
        { name: 'started_at', type: 'INTEGER' },
        { name: 'completed_at', type: 'INTEGER' }
      ]
    };
    for (const [table, expectedColumns] of Object.entries(tableStructures)) {
      const tableInfo = await config.database.prepare(`PRAGMA table_info(${table})`).all();
      const actualColumns = tableInfo.results;
      for (const expectedColumn of expectedColumns) {
        const found = actualColumns.some(col => 
          col.name.toLowerCase() === expectedColumn.name.toLowerCase() &&
          col.type.toUpperCase().includes(expectedColumn.type)
        );
        if (!found) {
          console.log(`表 ${table} 缺少列 ${expectedColumn.name}，尝试添加...`);
          try {
            await config.database.prepare(`ALTER TABLE ${table} ADD COLUMN ${expectedColumn.name} ${expectedColumn.type}`).run();
  } catch (error) {
            if (!error.message.includes('duplicate column name')) {
              throw error;
            }
          }
        }
      }
    }
    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id
      ON file_chunks(file_id, chunk_index)
    `).run();
    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_file_chunks_upload_id
      ON file_chunks(upload_id, chunk_index)
    `).run();
    await config.database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_files_upload_id
      ON files(upload_id)
      WHERE upload_id IS NOT NULL
    `).run();
    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_upload_sessions_chat_status
      ON bot_upload_sessions(chat_id, status, created_at)
    `).run();
    await config.database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_bot_upload_sessions_expires
      ON bot_upload_sessions(expires_at, status)
    `).run();

    console.log('检查默认分类...');
    const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    if (!defaultCategory) {
      console.log('默认分类不存在，正在创建...');
      try {
        const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
          .bind('默认分类', Date.now()).run();
        const newDefaultId = result.meta && result.meta.last_row_id;
        console.log(`默认分类创建成功，ID: ${newDefaultId}`);
        if (newDefaultId) {
          const filesResult = await config.database.prepare('SELECT COUNT(*) as count FROM files WHERE category_id IS NULL').first();
          if (filesResult && filesResult.count > 0) {
            console.log(`发现 ${filesResult.count} 个无分类文件，将它们分配到默认分类...`);
            await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id IS NULL')
              .bind(newDefaultId).run();
          }
          const settingsResult = await config.database.prepare('SELECT COUNT(*) as count FROM user_settings WHERE current_category_id IS NULL').first();
          if (settingsResult && settingsResult.count > 0) {
            console.log(`发现 ${settingsResult.count} 条用户设置没有当前分类，更新为默认分类...`);
            await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id IS NULL')
              .bind(newDefaultId).run();
          }
        }
      } catch (error) {
        console.error('创建默认分类失败:', error);
        throw new Error('无法创建默认分类: ' + error.message);
      }
    } else {
      console.log(`默认分类存在，ID: ${defaultCategory.id}`);
    }
    const checkAgain = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    if (!checkAgain) {
      throw new Error('验证失败：即使尝试创建后，默认分类仍然不存在');
    }
    return true;
  } catch (error) {
    console.error('验证数据库结构时出错:', error);
    return false;
  }
}
async function recreateCategoriesTable(config) {
  try {
    const existingData = await config.database.prepare('SELECT * FROM categories').all();
    await config.database.prepare('DROP TABLE IF EXISTS categories').run();
    await config.database.prepare(`
      CREATE TABLE categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `).run();
    if (existingData && existingData.results && existingData.results.length > 0) {
      for (const row of existingData.results) {
        await config.database.prepare('INSERT OR IGNORE INTO categories (id, name, created_at) VALUES (?, ?, ?)')
          .bind(row.id || null, row.name || '未命名分类', row.created_at || Date.now()).run();
      }
      console.log(`已恢复 ${existingData.results.length} 个分类数据`);
    }
    console.log("分类表重建完成");
  } catch (error) {
    console.error(`重建分类表失败: ${error.message}`);
  }
}
async function recreateUserSettingsTable(config) {
  try {
    await config.database.prepare('DROP TABLE IF EXISTS user_settings').run();
    await config.database.prepare(`
      CREATE TABLE user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL UNIQUE,
        storage_type TEXT DEFAULT 'telegram',
        category_id INTEGER,
        custom_suffix TEXT,
        waiting_for TEXT,
        editing_file_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    console.log('用户设置表重新创建成功');
    return true;
  } catch (error) {
    console.error('重新创建用户设置表失败:', error);
    return false;
  }
}
async function recreateFilesTable(config) {
  console.log('开始重建文件表...');
  try {
    const existingData = await config.database.prepare('SELECT * FROM files').all();
    await config.database.prepare('DROP TABLE IF EXISTS files').run();
    await config.database.prepare(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        fileId TEXT,
        message_id INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        chat_id TEXT,
        storage_type TEXT NOT NULL DEFAULT 'telegram',
        category_id INTEGER,
        custom_suffix TEXT,
        is_chunked INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        upload_id TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `).run();

    if (existingData && existingData.results && existingData.results.length > 0) {
      for (const row of existingData.results) {
        try {
          await config.database.prepare(`
            INSERT INTO files (
              id, url, fileId, message_id, created_at, file_name, file_size,
              mime_type, chat_id, storage_type, category_id, custom_suffix,
              is_chunked, chunk_count, upload_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            row.id || null,
            row.url,
            row.fileId || row.url,
            row.message_id || 0,
            row.created_at || Date.now(),
            row.file_name,
            row.file_size,
            row.mime_type,
            row.chat_id,
            row.storage_type || 'telegram',
            row.category_id,
            row.custom_suffix,
            Number(row.is_chunked || 0),
            Number(row.chunk_count || 0),
            row.upload_id || null
          ).run();
        } catch (error) {
          console.error(`恢复记录失败: ${error.message}`, row);
        }
      }
    }

    console.log('文件表重建完成!');
    return true;
  } catch (error) {
    console.error('重建文件表失败:', error);
    return false;
  }
}
async function checkAndAddMissingColumns(config) {
  try {
    await ensureColumnExists(config, 'files', 'custom_suffix', 'TEXT');
    await ensureColumnExists(config, 'files', 'chat_id', 'TEXT');
    await ensureColumnExists(config, 'files', 'is_chunked', 'INTEGER');
    await ensureColumnExists(config, 'files', 'chunk_count', 'INTEGER');
    await ensureColumnExists(config, 'files', 'upload_id', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'custom_suffix', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'waiting_for', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'editing_file_id', 'TEXT');
    await ensureColumnExists(config, 'user_settings', 'current_category_id', 'INTEGER');
    await ensureColumnExists(config, 'user_settings', 'is_processing', 'INTEGER');
    await ensureColumnExists(config, 'user_settings', 'lock_time', 'INTEGER');
    await ensureColumnExists(config, 'user_settings', 'upload_seq', 'INTEGER');
    return true;
  } catch (error) {
    console.error('检查并添加缺失列失败:', error);
    return false;
  }
}
// 尝试获取该 chat_id 的上传锁，同时分配一个排队序号
async function acquireUploadLock(chatId, config, maxWaitMs = 20000, pollMs = 300, lockTimeoutMs = 30 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const now = Date.now();
    const result = await config.database.prepare(
      `UPDATE user_settings 
       SET is_processing = 1, lock_time = ?
       WHERE chat_id = ? AND (
         is_processing IS NULL OR is_processing = 0 
         OR (lock_time IS NOT NULL AND ? - lock_time > ?)
       )`
    ).bind(now, chatId, now, lockTimeoutMs).run();
    if (result.meta && result.meta.changes > 0) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

async function releaseUploadLock(chatId, config) {
  try {
    await config.database.prepare(
      'UPDATE user_settings SET is_processing = 0 WHERE chat_id = ?'
    ).bind(chatId).run();
  } catch (error) {
    console.error('释放上传锁失败:', error);
  }
}
async function ensureColumnExists(config, tableName, columnName, columnType) {
  console.log(`确保列 ${columnName} 存在于表 ${tableName} 中...`); 
  try {
    console.log(`检查列 ${columnName} 是否存在于 ${tableName}...`); 
    const tableInfo = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
    const columnExists = tableInfo.results.some(col => col.name === columnName);
    if (columnExists) {
      console.log(`列 ${columnName} 已存在于表 ${tableName} 中`);
      return true; 
    }
    console.log(`列 ${columnName} 不存在于表 ${tableName}，尝试添加...`); 
    try {
      await config.database.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`).run();
      console.log(`列 ${columnName} 已成功添加到表 ${tableName}`);
      return true; 
    } catch (alterError) {
      console.warn(`添加列 ${columnName} 到 ${tableName} 时发生错误: ${alterError.message}. 尝试再次检查列是否存在...`, alterError); 
      const tableInfoAfterAttempt = await config.database.prepare(`PRAGMA table_info(${tableName})`).all();
      if (tableInfoAfterAttempt.results.some(col => col.name === columnName)) {
         console.log(`列 ${columnName} 在添加尝试失败后被发现存在于表 ${tableName} 中`);
         return true; 
      } else {
         console.error(`添加列 ${columnName} 到 ${tableName} 失败，并且再次检查后列仍不存在`);
         return false; 
      }
    }
  } catch (error) {
    console.error(`检查或添加表 ${tableName} 中的列 ${columnName} 时发生严重错误: ${error.message}`, error);
    return false; 
  }
}
// 将英文逗号分隔的 ID 转为数组
function normalizeIdList(value) {
  return String(value || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

// 检查是否为 TG_ADMIN_ID 管理员
function isTelegramAdmin(chatId, config) {
  const normalizedId = String(chatId || '').trim();

  return (
    Array.isArray(config.tgAdminId) &&
    config.tgAdminId.includes(normalizedId)
  );
}

// 验证 Telegram 私聊用户 ID
function normalizeTelegramUserId(value) {
  const normalizedId = String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();

  // 当前代码忽略群组消息，所以这里只接受正整数用户 ID
  if (!/^\d{5,20}$/.test(normalizedId)) {
    return null;
  }

  return normalizedId;
}

// 判断用户是否有权使用机器人
async function isAllowedTelegramUser(chatId, config) {
  const normalizedId = String(chatId || '').trim();

  // 管理员永远直接放行
  if (isTelegramAdmin(normalizedId, config)) {
    return true;
  }

  const user = await config.database.prepare(`
    SELECT chat_id
    FROM allowed_users
    WHERE chat_id = ?
    LIMIT 1
  `).bind(normalizedId).first();

  return !!user;
}

// 获取所有普通授权用户
async function listAllowedTelegramUsers(config) {
  const result = await config.database.prepare(`
    SELECT
      id,
      chat_id,
      added_by,
      created_at
    FROM allowed_users
    ORDER BY created_at DESC, id DESC
  `).all();

  const users = result.results || [];

  // 防止管理员同时出现在普通用户列表中
  return users.filter(user => {
    return !isTelegramAdmin(user.chat_id, config);
  });
}

// 添加普通授权用户
async function addAllowedTelegramUser(chatId, addedBy, config) {
  const normalizedId = normalizeTelegramUserId(chatId);

  if (!normalizedId) {
    throw new Error('用户 ID 格式不正确');
  }

  // 管理员本身不需要写入 allowed_users
  if (isTelegramAdmin(normalizedId, config)) {
    return {
      chatId: normalizedId,
      created: false,
      alreadyAdmin: true
    };
  }

  const existing = await config.database.prepare(`
    SELECT id
    FROM allowed_users
    WHERE chat_id = ?
    LIMIT 1
  `).bind(normalizedId).first();

  if (existing) {
    return {
      chatId: normalizedId,
      created: false,
      alreadyAdmin: false
    };
  }

  await config.database.prepare(`
    INSERT INTO allowed_users (
      chat_id,
      added_by,
      created_at
    )
    VALUES (?, ?, ?)
  `).bind(
    normalizedId,
    String(addedBy || ''),
    Date.now()
  ).run();

  return {
    chatId: normalizedId,
    created: true,
    alreadyAdmin: false
  };
}

// 删除普通用户授权
async function removeAllowedTelegramUser(chatId, config) {
  const normalizedId = normalizeTelegramUserId(chatId);

  if (!normalizedId) {
    throw new Error('用户 ID 格式不正确');
  }

  // 禁止删除 TG_ADMIN_ID
  if (isTelegramAdmin(normalizedId, config)) {
    throw new Error('TG_ADMIN_ID 管理员不能被删除');
  }

  const result = await config.database.prepare(`
    DELETE FROM allowed_users
    WHERE chat_id = ?
  `).bind(normalizedId).run();

  return !!(
    result.meta &&
    Number(result.meta.changes || 0) > 0
  );
}

// 网页上传归属于 TG_ADMIN_ID 中第一个管理员
function getWebOwnerChatId(config) {
  if (
    Array.isArray(config.tgAdminId) &&
    config.tgAdminId.length > 0
  ) {
    return config.tgAdminId[0];
  }

  return '';
}

function normalizeTelegramApiRoot(value) {
  const root = String(value || 'https://api.telegram.org').trim();
  return (root || 'https://api.telegram.org').replace(/\/+$/, '');
}

function getTelegramApiRoot(config = null) {
  return normalizeTelegramApiRoot(
    (config && config.tgApiBaseUrl) ||
    globalThis.__TG_BOT_API_BASE_URL ||
    'https://api.telegram.org'
  );
}

function getTelegramFileRoot(config = null) {
  return normalizeTelegramApiRoot(
    (config && config.tgFileBaseUrl) ||
    globalThis.__TG_BOT_FILE_BASE_URL ||
    getTelegramApiRoot(config)
  );
}

function telegramMethodUrl(botToken, method, config = null) {
  return `${getTelegramApiRoot(config)}/bot${botToken}/${String(method || '').replace(/^\/+/, '')}`;
}

function telegramFileDownloadUrl(botToken, filePath, config = null) {
  const path = String(filePath || '').replace(/^\/+/, '');
  return `${getTelegramFileRoot(config)}/file/bot${botToken}/${path}`;
}

async function fetchTelegramBinaryFile(
  fileId,
  filePath,
  config,
  requestHeaders = null
) {
  const headers = new Headers(requestHeaders || undefined);
  if (config && config.tgFileProxyUrl) {
    const proxyUrl = new URL(config.tgFileProxyUrl);
    proxyUrl.searchParams.set('file_id', String(fileId || ''));
    if (config.tgFileProxySecret) {
      headers.set('X-Telegram-File-Proxy-Secret', config.tgFileProxySecret);
    }
    return fetch(proxyUrl.toString(), { headers });
  }
  return fetch(
    telegramFileDownloadUrl(config.tgBotToken, filePath, config),
    { headers }
  );
}

async function setWebhook(webhookUrl, botToken) {
  if (!botToken) {
    console.log('未配置Telegram机器人令牌，跳过webhook设置');
    return true;
  }
  const maxRetries = 3;
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      console.log(`尝试设置webhook: ${webhookUrl}`);
      const response = await fetch(
        `${telegramMethodUrl(botToken, 'setWebhook')}?url=${encodeURIComponent(webhookUrl)}`
      );
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Telegram API错误: HTTP ${response.status} - ${errorText}`);
        retryCount++;
        continue;
      }
      const result = await response.json();
      if (!result.ok) {
        if (result.error_code === 429) {
          const retryAfter = result.parameters?.retry_after || 1;
          console.log(`请求频率限制，等待 ${retryAfter} 秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          retryCount++;
          continue;
        }
        console.error(`设置webhook失败: ${JSON.stringify(result)}`);
        return false;
      }
      console.log(`Webhook设置成功: ${webhookUrl}`);
    return true;
  } catch (error) {
      console.error(`设置webhook时出错: ${error.message}`);
      retryCount++;
      if (retryCount < maxRetries) {
        const delay = 1000 * Math.pow(2, retryCount);
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay)); 
      }
    }
  }
  console.error('多次尝试后仍未能设置webhook');
  return false;
}
function createLargeUploadMaintenanceConfig(env) {
  const tgApiBaseUrl = normalizeTelegramApiRoot(
    env.TG_BOT_API_BASE_URL || 'https://api.telegram.org'
  );
  return {
    database: env.DATABASE,
    tgBotToken: env.TG_BOT_TOKEN || '',
    tgApiBaseUrl,
    tgFileBaseUrl: normalizeTelegramApiRoot(
      env.TG_BOT_FILE_BASE_URL || tgApiBaseUrl
    ),
    tgStorageChatId: String(env.TG_STORAGE_CHAT_ID || '').trim(),
    fileCache: new Map(),
    fileCacheTTL: 3600000
  };
}

export default {
  async fetch(request, env, executionCtx) {
    if (!env.DATABASE) {
      console.error("缺少DATABASE配置");
      return new Response('缺少必要配置: DATABASE 环境变量未设置', { status: 500 });
    }
    const tgApiBaseUrl = normalizeTelegramApiRoot(
      env.TG_BOT_API_BASE_URL || 'https://api.telegram.org'
    );
    const tgFileBaseUrl = normalizeTelegramApiRoot(
      env.TG_BOT_FILE_BASE_URL || tgApiBaseUrl
    );
    const useLocalBotApi =
      String(env.TG_LOCAL_BOT_API || '').toLowerCase() === 'true' ||
      tgApiBaseUrl !== 'https://api.telegram.org';
    const tgFileProxyUrl = String(env.TG_FILE_PROXY_URL || '').trim();
    const allowLargeBotDownloads =
      useLocalBotApi &&
      (
        Boolean(tgFileProxyUrl) ||
        String(env.TG_LOCAL_FILE_ENDPOINT || '').toLowerCase() === 'true'
      );

    const updateTimeMinutes = Math.max(
      1,
      Math.floor(Number(env.UPDATE_TIME) || 20)
    );

    const config = {
      domain: env.DOMAIN || request.headers.get("host") || '',
      database: env.DATABASE,
      username: env.USERNAME || '',
      password: env.PASSWORD || '',
      enableAuth: env.ENABLE_AUTH === 'true' || false,
      tgBotToken: env.TG_BOT_TOKEN || '',
      tgApiBaseUrl,
      tgFileBaseUrl,
      tgFileProxyUrl,
      tgFileProxySecret: String(env.TG_FILE_PROXY_SECRET || ''),
      useLocalBotApi,
      allowLargeBotDownloads,
      tgAdminId: normalizeIdList(env.TG_ADMIN_ID),
      tgStorageChatId: String(env.TG_STORAGE_CHAT_ID || '').trim(),
      cookie: Number(env.COOKIE) || 7,
      // MAX_SIZE_MB 是业务总上限；Telegram 单片上限由下面几项单独控制
      maxSizeMB: Number(env.MAX_SIZE_MB) || 1024,
      telegramPhotoLimitMB: 10,
      telegramFileLimitMB: Number(env.TG_FILE_LIMIT_MB) || (useLocalBotApi ? 2000 : 50),
      telegramDownloadLimitMB: allowLargeBotDownloads
        ? Number(env.TG_LOCAL_DOWNLOAD_LIMIT_MB) || 2000
        : 20,
      // 公开 Bot API 的 getFile 下载上限仍为 20MB，因此分片必须低于 20MB
      telegramChunkSizeMB: Math.min(19, Math.max(1, Number(env.TG_CHUNK_SIZE_MB) || 19)),
      // 机器人专属大文件上传页在开始上传前的有效时长，单位：分钟
      updateTimeMinutes,
      bucket: env.BUCKET,
      fileCache: new Map(),
      fileCacheTTL: 3600000,
      buttonCache: new Map(),
      buttonCacheTTL: 600000,
      menuCache: new Map(),
      // 菜单含临时 URL，缓存最长不超过 UPDATE_TIME 的一半
      menuCacheTTL: Math.min(300000, updateTimeMinutes * 30 * 1000),
      notificationCache: '',
      notificationCacheTTL: 3600000,
      lastNotificationFetch: 0
    };

    // 兼容仍只接收 botToken 的旧辅助函数；同一 Worker 环境使用同一套 Telegram 端点
    globalThis.__TG_BOT_API_BASE_URL = config.tgApiBaseUrl;
    globalThis.__TG_BOT_FILE_BASE_URL = config.tgFileBaseUrl;
    if (config.enableAuth && (!config.username || !config.password)) {
        console.error("启用了认证但未配置用户名或密码");
        return new Response('认证配置错误: 缺少USERNAME或PASSWORD环境变量', { status: 500 });
    }
    const url = new URL(request.url);
    const { pathname } = url;
    console.log(`[Auth] Request Path: ${pathname}, Method: ${request.method}`);
    if (pathname === '/favicon.ico') {
      console.log('[Auth] Handling favicon.ico request.');
      return new Response(null, { status: 204 });
    }
    const isAuthEnabled = config.enableAuth;
    const isAuthenticated = authenticate(request, config);
    const isLoginPage = pathname === '/login';
    const isPublicApi = pathname === '/webhook' || pathname === '/config' || pathname === '/bing';
    console.log(`[Auth] isAuthEnabled: ${isAuthEnabled}, isAuthenticated: ${isAuthenticated}, isLoginPage: ${isLoginPage}, isPublicApi: ${isPublicApi}`);
    const protectedPaths = [
      '/',
      '/upload',
      '/upload-chunk',
      '/upload-complete',
      '/upload-abort',
      '/admin',

      // 用户管理页面和接口
      '/users',
      '/api/users',
      '/api/users/add',
      '/api/users/delete',

      '/create-category',
      '/delete-category',
      '/update-suffix',
      '/delete',
      '/delete-multiple',
      '/search'
    ];
    const requiresAuth = isAuthEnabled && protectedPaths.includes(pathname);
    console.log(`[Auth] Path requires authentication: ${requiresAuth}`);
    if (requiresAuth && !isAuthenticated && !isLoginPage) {
        console.log(`[Auth] FAILED: Accessing protected path ${pathname} without authentication. Redirecting to login.`);
        if (request.method === 'POST' || request.headers.get('Accept')?.includes('application/json')) {
            return new Response(JSON.stringify({ status: 0, error: "未授权访问", redirect: `${url.origin}/login` }), {
                status: 401,
                headers: { 
                    'Content-Type': 'application/json;charset=UTF-8',
                    'Cache-Control': 'no-store'
                 }
            });
        }
        const redirectUrl = `${url.origin}/login?redirect=${encodeURIComponent(pathname + url.search)}`;
        return Response.redirect(redirectUrl, 302);
    }
    if (isAuthEnabled && isAuthenticated && isLoginPage) {
        const redirectTarget = url.searchParams.get('redirect') || '/upload';
        console.log(`[Auth] SUCCESS: Authenticated user accessing login page. Redirecting to ${redirectTarget}.`);
        return Response.redirect(`${url.origin}${redirectTarget}`, 302);
    }
    console.log(`[Auth] Check PASSED for path: ${pathname}`);
    try {
      const shouldInitDatabase =
        !isLoginPage &&
        (
          pathname === '/webhook' ||
          !isPublicApi
        );

      if (shouldInitDatabase) {
        await initDatabase(config);
        console.log('[DB] Database initialized successfully.');
      } else {
        console.log(
          '[DB] Skipping database initialization for public API or login page.'
        );
      }
    } catch (error) {
      console.error(`[DB] Database initialization FAILED: ${error.message}`);
      return new Response(`数据库初始化失败: ${error.message}`, { 
        status: 500,
        headers: { 
            'Content-Type': 'text/plain;charset=UTF-8',
            'Cache-Control': 'no-store'
        }
      });
    }
    if (config.tgBotToken) {
      try {
        const webhookUrl = `https://${config.domain}/webhook`;
        console.log(`[Webhook] Attempting to set webhook to: ${webhookUrl}`);
        const webhookSet = await setWebhook(webhookUrl, config.tgBotToken);
        if (!webhookSet) { 
            console.error('[Webhook] FAILED to set webhook after retries.'); 
        } else {
            console.log('[Webhook] Webhook set successfully (or already set).');
        }
      } catch (error) {
        console.error(`[Webhook] FAILED to set webhook due to error: ${error.message}`);
      }
    }
    const routes = {
      '/': async () => {
          console.log('[Route] Handling / request.');
          return handleUploadRequest(request, config);
      },
      '/login': async () => {
          console.log('[Route] Handling /login request.');
          return handleLoginRequest(request, config);
      },
      '/upload': async () => {
          console.log('[Route] Handling /upload request.');
          return handleUploadRequest(request, config);
      },
      '/upload-chunk': async () => {
          console.log('[Route] Handling /upload-chunk request.');
          return handleUploadChunkRequest(request, config);
      },
      '/upload-complete': async () => {
          console.log('[Route] Handling /upload-complete request.');
          return handleUploadCompleteRequest(request, config);
      },
      '/upload-abort': async () => {
          console.log('[Route] Handling /upload-abort request.');
          return handleUploadAbortRequest(request, config);
      },
      '/large-upload': async () => {
          console.log('[Route] Handling /large-upload request.');
          return handleLargeUploadPageRequest(request, config);
      },
      '/large-upload/status': async () => {
          console.log('[Route] Handling /large-upload/status request.');
          return handleLargeUploadStatusRequest(request, config);
      },
      '/large-upload/chunk': async () => {
          console.log('[Route] Handling /large-upload/chunk request.');
          return handleLargeUploadChunkRequest(request, config);
      },
      '/large-upload/complete': async () => {
          console.log('[Route] Handling /large-upload/complete request.');
          return handleLargeUploadCompleteRequest(request, config);
      },
      '/admin': async () => {
          console.log('[Route] Handling /admin request.');
          return handleAdminRequest(request, config);
      },
      '/users': async () => {
        console.log('[Route] Handling /users request.');
        return handleUserManagementRequest(request, config);
      },

      '/api/users': async () => {
        console.log('[Route] Handling /api/users request.');
        return handleListAllowedUsersRequest(request, config);
      },

      '/api/users/add': async () => {
        console.log('[Route] Handling /api/users/add request.');
        return handleAddAllowedUserRequest(request, config);
      },

      '/api/users/delete': async () => {
        console.log('[Route] Handling /api/users/delete request.');
        return handleDeleteAllowedUserRequest(request, config);
      },
      '/delete': () => handleDeleteRequest(request, config),
      '/delete-multiple': () => handleDeleteMultipleRequest(request, config),
      '/search': () => handleSearchRequest(request, config),
      '/create-category': () => handleCreateCategoryRequest(request, config),
      '/delete-category': () => handleDeleteCategoryRequest(request, config),
      '/update-suffix': () => handleUpdateSuffixRequest(request, config),
      '/config': () => {
          console.log('[Route] Handling /config request.');
          const safeConfig = {
            maxSizeMB: config.maxSizeMB,
            telegramPhotoLimitMB: config.telegramPhotoLimitMB,
            telegramFileLimitMB: config.telegramFileLimitMB,
            telegramDownloadLimitMB: config.telegramDownloadLimitMB,
            telegramChunkSizeMB: config.telegramChunkSizeMB,
            updateTimeMinutes: config.updateTimeMinutes,
            largeUploadChunkTimeoutMinutes: LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES,
            useLocalBotApi: config.useLocalBotApi,
            allowLargeBotDownloads: config.allowLargeBotDownloads
          };
          return new Response(JSON.stringify(safeConfig), {
              headers: { 
                  'Content-Type': 'application/json',
                  'Cache-Control': 'public, max-age=3600'
               }
          });
      },
      '/webhook': () => { 
          console.log('[Route] Handling /webhook request.');
          return handleTelegramWebhook(request, config, executionCtx); 
      },
      '/bing': () => { 
          console.log('[Route] Handling /bing request.');
          return handleBingImagesRequest(request, config);
      }
    };
    const handler = routes[pathname];
    if (handler) {
      try {
          console.log(`[Route] Executing handler for ${pathname}`);
          const response = await handler();
          if (isAuthEnabled && requiresAuth && response.headers.get('Content-Type')?.includes('text/html')) {
              response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
              response.headers.set('Pragma', 'no-cache');
              response.headers.set('Expires', '0');
          }
          return response;
      } catch (error) {
          console.error(`[Route] Error handling route ${pathname}:`, error);
          return new Response("服务器内部错误", { status: 500, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    console.log(`[File] Handling file request for ${pathname}`);
    return await handleFileRequest(request, config);
  },

  // 需要在 Cloudflare Workers 中配置 Cron Trigger（建议每分钟执行一次）
  // 它保证用户关闭临时网页后，超时任务仍会被自动取消并清理分片
  async scheduled(_controller, env, executionCtx) {
    if (!env.DATABASE) {
      console.error('[Large Upload Cleanup] 缺少 DATABASE，跳过定时清理');
      return;
    }
    const config = createLargeUploadMaintenanceConfig(env);
    globalThis.__TG_BOT_API_BASE_URL = config.tgApiBaseUrl;
    globalThis.__TG_BOT_FILE_BASE_URL = config.tgFileBaseUrl;

    const task = (async () => {
      await initDatabase(config);
      const result = await cleanupStaleLargeUploadSessions(config);
      if (result.cancelled > 0) {
        console.log(
          `[Large Upload Cleanup] 已取消 ${result.cancelled} 个超时任务，` +
          `删除 ${result.deletedChunks} 个分片`
        );
      }
    })().catch(error => {
      console.error('[Large Upload Cleanup] 定时清理失败:', error);
    });

    if (executionCtx && typeof executionCtx.waitUntil === 'function') {
      executionCtx.waitUntil(task);
      return;
    }
    await task;
  }
};
async function handleTelegramWebhook(request, config, executionCtx = null) {
  try {
    const update = await request.json();
    let chatId;
    let userId;
    if (update.message) {
      chatId = update.message.chat.id.toString();
      userId = update.message.from.id.toString();
      console.log(`[Webhook] Received message from chat ID: ${chatId}, User ID: ${userId}`);
      // --- Ignore group/supergroup messages --- 
      if (update.message.chat.type === 'group' || update.message.chat.type === 'supergroup') {
        console.log(`[Webhook] Ignoring message from group/supergroup chat ID: ${chatId}`);
        return new Response('OK');
      }
      // --------------------------------------
    } else if (update.callback_query) {
      chatId = update.callback_query.from.id.toString();
      userId = update.callback_query.from.id.toString();
      console.log(`[Webhook] Received callback_query from chat ID: ${chatId}, User ID: ${userId}`);
    } else {
      console.log('[Webhook] Received update without message or callback_query:', JSON.stringify(update));
      return new Response('OK');
    }
    const isAdmin = isTelegramAdmin(chatId, config);

    let isAllowed = false;

    try {
      isAllowed =
        isAdmin ||
        await isAllowedTelegramUser(chatId, config);
    } catch (error) {
      console.error(
        `[Auth Check] 查询用户授权失败: ${error.message}`
      );

      return new Response(
        'Authorization database error',
        { status: 500 }
      );
    }

    if (!isAllowed) {
      console.log(
        `[Auth Check] FAILED: Chat ID ${chatId}, ` +
        `User ID ${userId} is not authorized.`
      );

      if (config.tgBotToken) {
        await sendMessage(
          chatId,
          "❌ 你无权使用，请联系管理员",
          config.tgBotToken
        );
      }

      return new Response('OK');
    }

    console.log(
      `[Auth Check] PASSED: Chat ID ${chatId}, ` +
      `User ID ${userId}, admin=${isAdmin}.`
    );
    let userSetting = await config.database.prepare('SELECT * FROM user_settings WHERE chat_id = ?').bind(chatId).first();
    if (!userSetting) {
      let defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind('默认分类').first();
      let defaultCategoryId = null;
      if (!defaultCategory) {
          try {
              console.log('默认分类不存在，为新用户创建...');
              const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
                  .bind('默认分类', Date.now()).run();
              defaultCategoryId = result.meta && result.meta.last_row_id;
              console.log(`新默认分类创建成功，ID: ${defaultCategoryId}`);
          } catch (error) {
              console.error('为新用户创建默认分类失败:', error);
          }
      } else {
          defaultCategoryId = defaultCategory.id;
      }
      await config.database.prepare('INSERT INTO user_settings (chat_id, storage_type, current_category_id) VALUES (?, ?, ?)')
         .bind(chatId, 'telegram', defaultCategoryId).run();

      userSetting = { 
       chat_id: chatId, 
       storage_type: 'telegram', 
       current_category_id: defaultCategoryId 
      };
    }
    if (update.message) {
      const incomingText =
        typeof update.message.text === 'string'
          ? update.message.text
          : '';

      /*
       * 等待输入期间，用户可以发送以下内容暂停：
       * /start
       * /cancel
       * 暂停
       * 取消
       * 返回
       */
      if (
        userSetting.waiting_for &&
        isPauseCommand(incomingText)
      ) {
        await resetWaitingState(
          chatId,
          userSetting,
          config
        );

        await sendMessage(
          chatId,
          "⏸ 已暂停当前操作，已返回主菜单",
          config.tgBotToken
        );

        await sendPanel(
          chatId,
          userSetting,
          config
        );

        return new Response('OK');
      }

      /*
       * 当前正在等待文字时，如果用户发送图片、文件、
       * 视频、语音或贴纸，不允许进入上传流程
       */
      if (
        userSetting.waiting_for &&
        !update.message.text
      ) {
        await sendInputPrompt(
          chatId,
          "⚠️ 当前操作需要文字输入\n\n" +
          getWaitingPromptText(
            userSetting.waiting_for
          ),
          config
        );

        return new Response('OK');
      }

      // 管理员正在输入要添加的用户 ID
      if (
        userSetting.waiting_for === 'add_user_id' &&
        update.message.text
      ) {
        // 再次验证管理员权限
        if (!isTelegramAdmin(chatId, config)) {
          await resetWaitingState(
            chatId,
            userSetting,
            config
          );

          await sendMessage(
            chatId,
            "❌ 只有 TG_ADMIN_ID 管理员可以添加用户",
            config.tgBotToken
          );

          await sendPanel(
            chatId,
            userSetting,
            config
          );

          return new Response('OK');
        }

        const targetUserId = normalizeTelegramUserId(
          update.message.text
        );

        /*
         * 输入不符合要求：
         * 不清除 waiting_for；
         * 不返回主菜单；
         * 继续等待管理员输入
         */
        if (!targetUserId) {
          await sendInputPrompt(
            chatId,
            "⚠️ 用户 ID 格式不正确\n\n" +
            "请继续输入纯数字 Telegram 用户 ID，" +
            "例如：123456789",
            config
          );

          return new Response('OK');
        }

        try {
          const result = await addAllowedTelegramUser(
            targetUserId,
            chatId,
            config
          );

          /*
           * ID 格式有效且数据库操作完成后，
           * 才清除等待状态
           */
          await resetWaitingState(
            chatId,
            userSetting,
            config
          );

          if (result.alreadyAdmin) {
            await sendMessage(
              chatId,
              `ℹ️ 用户 ${targetUserId} 已经是 ` +
              "TG_ADMIN_ID 管理员，无需重复添加",
              config.tgBotToken
            );
          } else if (!result.created) {
            await sendMessage(
              chatId,
              `ℹ️ 用户 ${targetUserId} 已经在授权列表中`,
              config.tgBotToken
            );
          } else {
            await sendMessage(
              chatId,
              `✅ 已添加授权用户：${targetUserId}`,
              config.tgBotToken
            );
          }

          await sendPanel(
            chatId,
            userSetting,
            config
          );

          return new Response('OK');
        } catch (error) {
          console.error(
            '添加授权用户失败:',
            error
          );

          /*
           * 数据库错误时也不要清除状态
           * 管理员仍可以重新输入，或者点击暂停按钮
           */
          await sendInputPrompt(
            chatId,
            "❌ 添加用户失败：" +
            escapeHtml(error.message) +
            "\n\n请重新输入用户 ID，" +
            "或点击下方按钮暂停",
            config
          );

          return new Response('OK');
        }
      }
      else if (
        userSetting.waiting_for === 'new_category' &&
        update.message.text
      ) {
        const categoryName = String(
          update.message.text || ''
        ).trim();

        if (!categoryName) {
          await sendInputPrompt(
            chatId,
            "⚠️ 分类名称不能为空\n\n" +
            "请继续输入新分类名称",
            config
          );

          return new Response('OK');
        }

        if (categoryName.length > 50) {
          await sendInputPrompt(
            chatId,
            "⚠️ 分类名称不能超过 50 个字符\n\n" +
            "请重新输入",
            config
          );

          return new Response('OK');
        }

        try {
          const existingCategory =
            await config.database.prepare(`
              SELECT id
              FROM categories
              WHERE name = ?
              LIMIT 1
            `).bind(categoryName).first();

          if (existingCategory) {
            await sendInputPrompt(
              chatId,
              `⚠️ 分类“${escapeHtml(categoryName)}”已存在\n\n` +
              "请继续输入其他分类名称",
              config
            );

            return new Response('OK');
          }

          const result =
            await config.database.prepare(`
              INSERT INTO categories (
                name,
                created_at
              )
              VALUES (?, ?)
            `).bind(
              categoryName,
              Date.now()
            ).run();

          let newCategoryId =
            result.meta &&
            result.meta.last_row_id;

          if (!newCategoryId) {
            const newCategory =
              await config.database.prepare(`
                SELECT id
                FROM categories
                WHERE name = ?
                LIMIT 1
              `).bind(categoryName).first();

            newCategoryId =
              newCategory && newCategory.id;
          }

          if (!newCategoryId) {
            throw new Error(
              '创建后未能获取分类 ID'
            );
          }

          await config.database.prepare(`
            UPDATE user_settings
            SET current_category_id = ?,
                waiting_for = NULL,
                editing_file_id = NULL
            WHERE chat_id = ?
          `).bind(
            newCategoryId,
            chatId
          ).run();

          userSetting.current_category_id =
            newCategoryId;

          userSetting.waiting_for = null;
          userSetting.editing_file_id = null;

          await sendMessage(
            chatId,
            `✅ 分类“${escapeHtml(categoryName)}”` +
            "创建成功，并已设为当前分类",
            config.tgBotToken
          );

          await sendPanel(
            chatId,
            userSetting,
            config
          );

          return new Response('OK');
        } catch (error) {
          console.error(
            '创建分类失败:',
            error
          );

          // 出错后仍保留 new_category 状态
          await sendInputPrompt(
            chatId,
            "❌ 创建分类失败：" +
            escapeHtml(error.message) +
            "\n\n请重新输入，或点击暂停",
            config
          );

          return new Response('OK');
        }
      }
      else if (userSetting.waiting_for === 'new_suffix' && update.message.text && userSetting.editing_file_id) {
        const fileId = userSetting.editing_file_id;
        try {
          const file = await config.database.prepare(
            'SELECT * FROM files WHERE id = ? AND chat_id = ?'
          ).bind(fileId, chatId).first();
          if (!file) {
            await sendMessage(chatId, "⚠️ 文件不存在、已被删除或不属于当前用户", config.tgBotToken);
          } else {
            const renamed = await renameStoredFileRecord(
              file,
              update.message.text,
              config
            );
            const chunkText = renamed.isChunked
              ? `
🧩 分片：${renamed.chunkCount} 个（无需重新上传分片）`
              : '';
            await sendMessage(
              chatId,
              `✅ 文件名修改成功！${chunkText}

新名称：${escapeHtml(renamed.fileName)}
新链接：${renamed.url}`,
              config.tgBotToken
            );
          }
        } catch (error) {
          console.error('修改文件名失败:', error);
          await sendMessage(chatId, `❌ 修改失败: ${escapeHtml(error.message)}`, config.tgBotToken);
        }
        await resetWaitingState(chatId, userSetting, config);
        await sendPanel(chatId, userSetting, config);
        return new Response('OK');
      }
      else if (userSetting.waiting_for === 'delete_file_input' && update.message.text) {
        try {
          const userInput = update.message.text;
          let fileToDelete = await findFileRecord(userInput, chatId, config);
          if (!fileToDelete) {
            await sendInputPrompt(
              chatId,
              "⚠️ 未找到匹配的文件\n\n" +
              "请继续输入完整文件名称或完整 URL",
              config
            );

            return new Response('OK');
          }
          const fileName = fileToDelete.file_name || getFileName(fileToDelete.url);
          console.log(`[TG Delete] 找到匹配文件: ID=${fileToDelete.id}, 名称=${fileName}, URL=${fileToDelete.url}`);
          console.log(`[TG Delete] 开始删除: ID=${fileToDelete.id}, 类型=${fileToDelete.storage_type}, TGMsgID=${fileToDelete.message_id}, R2ID=${fileToDelete.fileId}`);
          await deleteStoredFileRecord(fileToDelete, config);
          await resetWaitingState(
            chatId,
            userSetting,
            config
          );
          console.log(`[TG Delete] 存储对象、分片和数据库记录已删除: ID=${fileToDelete.id}`);
          const cacheKey = `file:${fileName}`;
          if (config.fileCache && config.fileCache.has(cacheKey)) {
            config.fileCache.delete(cacheKey);
            console.log(`[TG Delete] 文件缓存已清除: ${cacheKey}`);
          }
          await sendMessage(chatId, `✅ 文件已成功删除: ${fileName}`, config.tgBotToken);
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        } catch (error) {
          console.error(`[TG Delete] 删除过程中出错:`, error);
          await sendMessage(chatId, `❌ 删除文件时出错: ${error.message}`, config.tgBotToken);
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        }
      }
      if (update.message.text === '/start') {
        await sendPanel(chatId, userSetting, config);
      }
      else if (update.message.photo || update.message.document || update.message.video || update.message.audio || update.message.voice || update.message.video_note) {
        console.log('收到文件上传:', JSON.stringify({
          hasPhoto: !!update.message.photo,
          hasDocument: !!update.message.document,
          hasVideo: !!update.message.video,
          hasAudio: !!update.message.audio,
          hasVoice: !!update.message.voice,
          hasVideoNote: !!update.message.video_note
        }));
        let file;
        let isDocument = false;
        if (update.message.document) {
          file = update.message.document;
          isDocument = true;
        } else if (update.message.video) {
          file = update.message.video;
          isDocument = true;
        } else if (update.message.audio) {
          file = update.message.audio;
          isDocument = true;
        } else if (update.message.voice) {
          file = update.message.voice;
          isDocument = true;
        } else if (update.message.video_note) {
          file = update.message.video_note;
          isDocument = true;
        } else if (update.message.photo) {
          file = update.message.photo && update.message.photo.length ? update.message.photo[update.message.photo.length - 1] : null;
          isDocument = false;
        }
        if (file) {
          const processMediaUpload = async () => {
            const gotLock = await acquireUploadLock(chatId, config);
            if (!gotLock) {
              await sendMessage(chatId, "⏳ 有其他文件正在处理中，请稍后重试或稍等片刻", config.tgBotToken);
              return;
            }
            try {
              await handleMediaUpload(
                chatId,
                file,
                isDocument,
                config,
                userSetting,
                update.message.message_id
              );
            } finally {
              await releaseUploadLock(chatId, config);
            }
          };

          if (executionCtx && typeof executionCtx.waitUntil === 'function') {
            executionCtx.waitUntil(processMediaUpload());
            return new Response('OK');
          }
          await processMediaUpload();
        } else {
          await sendMessage(chatId, "❌ 无法识别的文件类型", config.tgBotToken);
        }
      }
      else {
        const message = update.message;
        let fileField = null;
        for (const field in message) {
          if (message[field] && typeof message[field] === 'object' && message[field].file_id) {
            fileField = field;
            break;
          }
        }
        if (fileField) {
          console.log(`找到未明确处理的文件类型: ${fileField}`, JSON.stringify(message[fileField]));
          const processUnknownMediaUpload = async () => {
            const gotLock = await acquireUploadLock(chatId, config);
            if (!gotLock) {
              await sendMessage(chatId, "⏳ 有其他文件正在处理中，请稍后重试", config.tgBotToken);
              return;
            }
            try {
              await handleMediaUpload(
                chatId,
                message[fileField],
                true,
                config,
                userSetting,
                update.message.message_id
              );
            } finally {
              await releaseUploadLock(chatId, config);
            }
          };

          if (executionCtx && typeof executionCtx.waitUntil === 'function') {
            executionCtx.waitUntil(processUnknownMediaUpload());
            return new Response('OK');
          }
          await processUnknownMediaUpload();
        } else if (userSetting.waiting_for === 'edit_suffix_input_file' && message.text) {
          try {
            const userInput = message.text.trim();
            let fileToEdit = null;
            if (userInput.startsWith('http://') || userInput.startsWith('https://')) {
              fileToEdit = await config.database.prepare(
                'SELECT id, url, file_name FROM files WHERE url = ? AND chat_id = ?'
              ).bind(userInput, chatId).first();
            } else {
              let fileName = userInput;
              if (!fileName.includes('.')) {
                await sendMessage(chatId, "⚠️ 请输入完整的文件名称（包含扩展名）或完整URL", config.tgBotToken);
                await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                  .bind(chatId).run();
                userSetting.waiting_for = null;
                userSetting.editing_file_id = null;
                await sendPanel(chatId, userSetting, config);
                return new Response('OK');
              }
              fileToEdit = await config.database.prepare(
                'SELECT id, url, file_name FROM files WHERE (file_name = ? OR url LIKE ?) AND chat_id = ? ORDER BY created_at DESC LIMIT 1'
              ).bind(fileName, `%/${fileName}`, chatId).first();
            }
            if (!fileToEdit) {
              await sendMessage(chatId, "⚠️ 未找到匹配的文件，请输入完整的文件名称或URL", config.tgBotToken);
              await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
                .bind(chatId).run();
              userSetting.waiting_for = null;
              userSetting.editing_file_id = null;
              await sendPanel(chatId, userSetting, config);
              return new Response('OK');
            }
            const fileName = fileToEdit.file_name || getFileName(fileToEdit.url);
            const fileNameParts = fileName.split('.');
            const extension = fileNameParts.pop();
            const currentSuffix = fileNameParts.join('.');
            await config.database.prepare('UPDATE user_settings SET waiting_for = ?, editing_file_id = ? WHERE chat_id = ?')
              .bind('edit_suffix_input_new', fileToEdit.id, chatId).run();
            userSetting.waiting_for = 'edit_suffix_input_new';
            userSetting.editing_file_id = fileToEdit.id;
            await sendMessage(
              chatId,
              `📝 找到文件: ${fileName}\n当前后缀: ${currentSuffix}\n\n请回复此消息，输入文件的新后缀（不含扩展名）`,
              config.tgBotToken
            );
            return new Response('OK');
          } catch (error) {
            console.error('处理修改后缀文件选择失败:', error);
            await sendMessage(chatId, `❌ 处理失败: ${error.message}`, config.tgBotToken);
            await config.database.prepare('UPDATE user_settings SET waiting_for = NULL, editing_file_id = NULL WHERE chat_id = ?')
              .bind(chatId).run();
            userSetting.waiting_for = null;
            userSetting.editing_file_id = null;
            await sendPanel(chatId, userSetting, config);
            return new Response('OK');
          }
        } else if (userSetting.waiting_for === 'edit_suffix_input_new' && message.text && userSetting.editing_file_id) {
          const fileId = userSetting.editing_file_id;
          try {
            const file = await config.database.prepare(
              'SELECT * FROM files WHERE id = ? AND chat_id = ?'
            ).bind(fileId, chatId).first();
            if (!file) {
              await sendMessage(chatId, "⚠️ 文件不存在、已被删除或不属于当前用户", config.tgBotToken);
            } else {
              const renamed = await renameStoredFileRecord(file, message.text, config);
              const chunkText = renamed.isChunked
                ? `
🧩 分片：${renamed.chunkCount} 个（无需重新上传分片）`
                : '';
              await sendMessage(
                chatId,
                `✅ 文件名修改成功！${chunkText}

新名称：${escapeHtml(renamed.fileName)}
新链接：${renamed.url}`,
                config.tgBotToken
              );
            }
          } catch (error) {
            console.error('修改文件名失败:', error);
            await sendMessage(chatId, `❌ 修改失败: ${escapeHtml(error.message)}`, config.tgBotToken);
          }
          await resetWaitingState(chatId, userSetting, config);
          await sendPanel(chatId, userSetting, config);
          return new Response('OK');
        } else if (message.text && message.text !== '/start') {
          await sendMessage(chatId, "请发送图片或文件进行上传，或使用 /start 查看主菜单", config.tgBotToken);
        }
      }
    }
    else if (update.callback_query) {
      await handleCallbackQuery(update, config, userSetting);
    }
    return new Response('OK');
  } catch (error) {
    console.error('Error handling webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
}
async function sendPanel(chatId, userSetting, config) {
  try {
    const menuRole = isTelegramAdmin(chatId, config)
      ? 'admin'
      : 'user';

    const cacheKey =
      `menu:${chatId}:` +
      `${userSetting.storage_type || 'default'}:` +
      `${menuRole}`;
    if (config.menuCache && config.menuCache.has(cacheKey)) {
      const cachedData = config.menuCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.menuCacheTTL) {
        console.log(`使用缓存的菜单: ${cacheKey}`);
        const response = await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: cachedData.menuData
        });
        if (!response.ok) {
          config.menuCache.delete(cacheKey);
          console.log(`缓存菜单发送失败，重新生成: ${await response.text()}`);
        } else {
          return await response.json();
        }
      } else {
        config.menuCache.delete(cacheKey);
      }
    }
    const { messageBody, keyboard } = await generateMainMenu(chatId, userSetting, config);
    const menuData = JSON.stringify({
      chat_id: chatId,
      text: messageBody,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
    if (config.menuCache) {
      config.menuCache.set(cacheKey, {
        menuData,
        timestamp: Date.now()
      });
    }
    const response = await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: menuData
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`发送面板失败: ${errorText}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.error('发送面板出错:', error);
    return null;
  }
}
async function generateMainMenu(chatId, userSetting, config) {
  const storageText = userSetting.storage_type === 'r2' ? 'R2对象存储' : 'Telegram存储';
  let categoryName = '未选择分类';
  const categoryPromise = userSetting.current_category_id ? 
      config.database.prepare('SELECT name FROM categories WHERE id = ?')
        .bind(userSetting.current_category_id).first() 
      : Promise.resolve(null);
  const statsPromise = config.database.prepare(`
    SELECT COUNT(*) as total_files, SUM(file_size) as total_size
    FROM files WHERE chat_id = ?
  `).bind(chatId).first();
  const notificationPromise = (async () => {
    const now = Date.now();
    if (!config.notificationCache || (now - config.lastNotificationFetch > config.notificationCacheTTL)) {
      try {
        console.log('[Notification] Fetching new notification...');
        config.notificationCache = await fetchNotification();
        config.lastNotificationFetch = now;
      } catch (error) {
        console.error('[Notification] Failed to fetch notification:', error);
        config.notificationCache = config.notificationCache || ''; 
      }
    }
    return config.notificationCache;
  })();
  const largeUploadSessionPromise = createLargeUploadSession(
    chatId,
    userSetting,
    config
  ).catch(error => {
    console.error('创建大文件上传临时页面失败:', error);
    return null;
  });

  const [categoryResult, stats, notificationText, largeUploadSession] = await Promise.all([
    categoryPromise,
    statsPromise,
    notificationPromise,
    largeUploadSessionPromise
  ]);
  if (categoryResult) {
    categoryName = categoryResult.name;
  }
  const defaultNotification = 
  "➡️ 现在您可以直接发送图片或文件，上传完成后会自动生成图床直链\n" +
  "  ➡️ 所有上传的文件都可以在网页后台管理，支持删除、查看、分类等操作";
  const messageBody = `☁️ <b>图床助手v1</b>
  📂 当前存储：${storageText}
  🏷️ 当前分类：${categoryName}
  📊 已上传：${stats && stats.total_files ? stats.total_files : 0} 个文件
  💾 已用空间：${formatSize(stats && stats.total_size ? stats.total_size : 0)}
  📤 超出20MB请使用上传大文件
  ${defaultNotification}

  👇 请选择操作：`;
  const keyboard = getKeyboardLayout(
    userSetting,
    isTelegramAdmin(chatId, config),
    largeUploadSession && largeUploadSession.url,
    config.domain
  );
  return { messageBody, keyboard };
}
function getKeyboardLayout(userSetting, isAdmin = false, largeUploadUrl = '', domain = '') {
  const rows = [];

  // URL 按钮可在一次点击后直接打开专属页面；链接由菜单生成时临时创建
  if (largeUploadUrl) {
    rows.push([
      {
        text: "📤 上传大文件",
        url: largeUploadUrl
      }
    ]);
  }

  rows.push([
    {
      text: "📋 选择分类",
      callback_data: "list_categories"
    }
  ]);

  // 仅管理员显示用户管理按钮
  if (isAdmin) {
    rows.push([
      {
        text: "🔄 切换存储",
        callback_data: "switch_storage"
      },
      {
        text: "📊 R2统计",
        callback_data: "r2_stats"
      },
      {
        text: "📝 创建分类",
        callback_data: "create_category"
      },
    ],
    [
      {
        text: "➕ 添加用户",
        callback_data: "add_user"
      },
      {
        text: "➖ 删除用户",
        callback_data: "delete_user"
      }
    ]);
  }

  rows.push(
    [
      {
        text: "📂 最近文件",
        callback_data: "recent_files"
      },
      {
        text: "✏️ 修改后缀",
        callback_data: "edit_suffix_input"
      },
      {
        text: "🗑️ 删除文件",
        callback_data: "delete_file_input"
      }
    ],
    [
      {
        text: "🔗 网页版后台",
      url: domain.startsWith('http') ? domain : `https://${domain}`
      }
    ]
  );

  return {
    inline_keyboard: rows
  };
}
// 生成简洁的存储 key，避免用杂乱原始文件名拼URL
function generateSafeKey(originalName) {
  let ext = 'bin';
  if (originalName && originalName.includes('.')) {
    const rawExt = originalName.split('.').pop();
    const cleanExt = rawExt.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (cleanExt) ext = cleanExt;
  }
  const randomPart = Math.random().toString(36).slice(2, 8); // 6位随机字符
  return `${Date.now()}_${randomPart}.${ext}`;
}

// 去除零宽字符/首尾空白，防止复制粘贴带入不可见字符导致匹配失败
function normalizeInput(str) {
  return (str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

// 从URL或文本中提取路径最后一段（文件名部分）
function extractKeyFromInput(input) {
  try {
    if (input.startsWith('http://') || input.startsWith('https://')) {
      const u = new URL(input);
      return decodeURIComponent(u.pathname.split('/').pop());
    }
  } catch (e) {}
  return input.split('/').pop();
}

// 综合查找：精确URL -> http/https互换 -> basename(fileId/url片段) -> 原始文件名
async function findFileRecord(rawInput, chatId, config) {
  const input = normalizeInput(rawInput);
  if (!input) return null;
  const isUrl = input.startsWith('http://') || input.startsWith('https://');
  const basename = extractKeyFromInput(input);

  if (isUrl) {
    let rec = await config.database.prepare(
      'SELECT * FROM files WHERE url = ? AND (chat_id = ? OR chat_id IS NULL)'
    ).bind(input, chatId).first();
    if (rec) return rec;

    const altUrl = input.startsWith('https://')
      ? 'http://' + input.slice('https://'.length)
      : 'https://' + input.slice('http://'.length);
    rec = await config.database.prepare(
      'SELECT * FROM files WHERE url = ? AND (chat_id = ? OR chat_id IS NULL)'
    ).bind(altUrl, chatId).first();
    if (rec) return rec;
  }

  if (basename) {
    let rec = await config.database.prepare(
      'SELECT * FROM files WHERE (fileId = ? OR url LIKE ?) AND (chat_id = ? OR chat_id IS NULL) ORDER BY created_at DESC LIMIT 1'
    ).bind(basename, `%/${basename}`, chatId).first();
    if (rec) return rec;
  }

  if (!isUrl) {
    let rec = await config.database.prepare(
      'SELECT * FROM files WHERE (file_name = ? OR url LIKE ?) AND (chat_id = ? OR chat_id IS NULL) ORDER BY created_at DESC LIMIT 1'
    ).bind(input, `%/${input}`, chatId).first();
    if (rec) return rec;
  }

  return null;
}
async function handleCallbackQuery(update, config, userSetting) {
  const chatId = update.callback_query.from.id.toString();
  const cbData = update.callback_query.data;
  const answerPromise = fetch(telegramMethodUrl(config.tgBotToken, 'answerCallbackQuery', config), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: update.callback_query.id })
  }).catch(error => {
    console.error('确认回调查询失败:', error);
  });
  try {
    // 点击“暂停并返回主菜单”
    if (cbData === 'pause_and_back') {
      await answerPromise;

      // 清空当前操作状态
      await resetWaitingState(
        chatId,
        userSetting,
        config
      );

      // 删除带暂停按钮的提示
      await deleteCallbackSourceMessage(
        update,
        config
      );

      // 回到初始主菜单
      await sendPanel(
        chatId,
        userSetting,
        config
      );

      return;
    }
    if (
      userSetting.waiting_for &&
      !cbData.startsWith('delete_file_do_')
    ) {
      if (
        !(
          userSetting.waiting_for === 'new_suffix' &&
          cbData.startsWith('edit_suffix_file_')
        ) &&
        !(
          userSetting.waiting_for === 'new_category' &&
          cbData === 'create_category'
        ) &&
        !(
          userSetting.waiting_for === 'add_user_id' &&
          cbData === 'add_user'
        ) &&
        !(
          userSetting.waiting_for === 'delete_file_input' &&
          cbData === 'delete_file_input'
        ) &&
        !(
          userSetting.waiting_for === 'edit_suffix_input_file' &&
          cbData === 'edit_suffix_input'
        ) &&
        !(
          userSetting.waiting_for === 'edit_suffix_input_new' &&
          userSetting.editing_file_id
        )
      ) {
        await config.database.prepare(`
          UPDATE user_settings
          SET waiting_for = NULL,
              editing_file_id = NULL
          WHERE chat_id = ?
        `).bind(chatId).run();

        userSetting.waiting_for = null;
        userSetting.editing_file_id = null;
      }
    }
    const cacheKey = `button:${chatId}:${cbData}`;
    const isStatefulOrNavigationCallback =
      cbData === 'switch_storage' ||
      cbData === 'add_user' ||
      cbData === 'delete_user' ||
      cbData === 'create_category' ||
      cbData === 'list_categories' ||
      cbData === 'recent_files' ||
      cbData === 'edit_suffix' ||
      cbData === 'edit_suffix_input' ||
      cbData === 'delete_file_input' ||
      cbData === 'back_to_panel' ||
      cbData === 'pause_and_back' ||
      cbData.startsWith('remove_user_') ||
      cbData.startsWith('set_category_') ||
      cbData.startsWith('edit_suffix_file_');
    if (
      config.buttonCache &&
      config.buttonCache.has(cacheKey) &&
      !isStatefulOrNavigationCallback &&
      !cbData.startsWith('delete_file_confirm_') &&
      !cbData.startsWith('delete_file_do_')
    ) {
      const cachedData = config.buttonCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.buttonCacheTTL) {
        console.log(`使用缓存的按钮响应: ${cacheKey}`);
        await answerPromise;
        if (cachedData.responseText) {
          await sendMessage(chatId, cachedData.responseText, config.tgBotToken);
        }
        if (cachedData.sendPanel) {
          await sendPanel(chatId, userSetting, config);
        }
        if (cachedData.replyMarkup) {
          await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: cachedData.replyText,
              reply_markup: cachedData.replyMarkup,
              parse_mode: 'HTML',
              disable_web_page_preview: cachedData.disablePreview || false
            })
          });
        }
        return;
      } else {
        config.buttonCache.delete(cacheKey);
      }
    }
    if (cbData === 'switch_storage') {
      // 管理员权限验证
      if (
        config.tgAdminId &&
        config.tgAdminId.length > 0 &&
        !config.tgAdminId.includes(chatId)
      ) {
        await answerPromise;

        await sendMessage(
          chatId,
          "❌ 你没有权限切换存储模式",
          config.tgBotToken
        );

        return;
      }

      const newStorageType =
        userSetting.storage_type === 'telegram'
          ? 'r2'
          : 'telegram';

      await Promise.all([
        config.database.prepare(
          'UPDATE user_settings SET storage_type = ? WHERE chat_id = ?'
        )
        .bind(newStorageType, chatId)
        .run(),

        answerPromise
      ]);

      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          sendPanel: true
        });
      }

      await sendMessage(
        chatId,
        `✅ 已切换存储模式：${newStorageType === 'r2' ? 'R2对象存储' : 'Telegram存储'}`,
        config.tgBotToken
      );

      await sendPanel(
        chatId,
        { ...userSetting, storage_type: newStorageType },
        config
      );
    }
    else if (cbData === 'add_user') {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;

        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以添加用户",
          config.tgBotToken
        );

        return;
      }

      await Promise.all([
        answerPromise,

        config.database.prepare(`
          UPDATE user_settings
          SET waiting_for = ?,
              editing_file_id = NULL
          WHERE chat_id = ?
        `).bind(
          'add_user_id',
          chatId
        ).run()
      ]);

      userSetting.waiting_for = 'add_user_id';
      userSetting.editing_file_id = null;

      await sendInputPrompt(
        chatId,
        "➕ 请输入需要授权的 Telegram 用户 ID\n\n" +
        "只输入纯数字，例如：123456789",
        config
      );
    }
    else if (cbData === 'delete_user') {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;

        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以删除用户",
          config.tgBotToken
        );

        return;
      }

      const users = await listAllowedTelegramUsers(config);

      await answerPromise;

      if (!users.length) {
        await sendMessage(
          chatId,
          "ℹ️ 当前没有普通授权用户",
          config.tgBotToken
        );

        return;
      }

      const userButtons = users.map(user => {
        return [
          {
            text: `🗑️ ${user.chat_id}`,
            callback_data: `remove_user_${user.chat_id}`
          }
        ];
      });

      userButtons.push([
        {
          text: "« 返回",
          callback_data: "back_to_panel"
        }
      ]);

      // 删除上一级主菜单
      await deleteCallbackSourceMessage(
        update,
        config
      );

      await fetch(
        telegramMethodUrl(config.tgBotToken, 'sendMessage', config),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId,
            text:
              "➖ 请选择要取消授权的用户：\n\n" +
              "删除授权不会删除该用户已经上传的文件",
            reply_markup: {
              inline_keyboard: userButtons
            }
          })
        }
      );
    }
    else if (cbData.startsWith('remove_user_')) {
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;

        await sendMessage(
          chatId,
          "❌ 只有 TG_ADMIN_ID 管理员可以删除用户",
          config.tgBotToken
        );

        return;
      }

      const targetUserId = normalizeTelegramUserId(
        cbData.slice('remove_user_'.length)
      );

      await answerPromise;

      if (!targetUserId) {
        await sendMessage(
          chatId,
          "❌ 无效的 Telegram 用户 ID",
          config.tgBotToken
        );

        return;
      }

      try {
        const removed = await removeAllowedTelegramUser(
          targetUserId,
          config
        );

        if (removed) {
          await sendMessage(
            chatId,
            `✅ 已取消用户 ${targetUserId} 的使用权限`,
            config.tgBotToken
          );
        } else {
          await sendMessage(
            chatId,
            `ℹ️ 用户 ${targetUserId} 已不在授权列表中`,
            config.tgBotToken
          );
        }
      } catch (error) {
        console.error('删除授权用户失败:', error);

        await sendMessage(
          chatId,
          `❌ 删除用户失败：${error.message}`,
          config.tgBotToken
        );
      }

      await deleteCallbackSourceMessage(
        update,
        config
      );
      await sendPanel(chatId, userSetting, config);
    }
    else if (cbData === 'list_categories') {
      const categoriesPromise = config.database.prepare('SELECT id, name FROM categories').all();
      await answerPromise;
      const categories = await categoriesPromise;
      if (!categories.results || categories.results.length === 0) {
        await sendMessage(chatId, "⚠️ 暂无分类，请先创建分类", config.tgBotToken);
        return;
      }
      const categoriesText = categories.results.map((cat, i) =>
        `${i + 1}. ${cat.name}`
      ).join('\n');
      const keyboard = {
        inline_keyboard: categories.results.map(cat => [
          { text: cat.name, callback_data: `set_category_${cat.id}` }
        ]).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
      };

      // 下一级包含返回按钮，删除上一级主菜单
      await deleteCallbackSourceMessage(
        update,
        config
      );

      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          replyText: "📂 请选择要使用的分类：\n\n" + categoriesText,
          replyMarkup: keyboard
        });
      }

      await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📂 请选择要使用的分类：\n\n" + categoriesText,
          reply_markup: keyboard
        })
      });
    }
    else if (cbData === 'create_category') {
      // 只有 TG_ADMIN_ID 管理员可以创建分类
      if (!isTelegramAdmin(chatId, config)) {
        await answerPromise;

        await sendMessage(
          chatId,
          "❌ 你没有权限创建分类，请联系管理员",
          config.tgBotToken
        );

        return;
      }

      // 先确认按钮回调并写入等待状态，再发送带“暂停”按钮的输入提示
      // 原代码误将 config 对象当作 botToken 传给 sendMessage，
      // 导致请求地址变成 bot[object Object]/sendMessage，点击后看起来没有反应
      await Promise.all([
        answerPromise,
        config.database.prepare(`
          UPDATE user_settings
          SET waiting_for = ?,
              editing_file_id = NULL
          WHERE chat_id = ?
        `).bind(
          'new_category',
          chatId
        ).run()
      ]);

      userSetting.waiting_for = 'new_category';
      userSetting.editing_file_id = null;

      await sendInputPrompt(
        chatId,
        "📝 请输入新分类名称\n\n" +
        "分类名称最多 50 个字符",
        config
      );
    }
    else if (cbData.startsWith('set_category_')) {
      const categoryId = Number(
        cbData.slice('set_category_'.length)
      );

      await answerPromise;

      if (
        !Number.isInteger(categoryId) ||
        categoryId <= 0
      ) {
        await sendMessage(
          chatId,
          "❌ 无效的分类 ID",
          config.tgBotToken
        );

        return;
      }

      const category = await config.database.prepare(`
        SELECT id, name
        FROM categories
        WHERE id = ?
        LIMIT 1
      `).bind(categoryId).first();

      if (!category) {
        await sendMessage(
          chatId,
          "⚠️ 该分类不存在或已被删除",
          config.tgBotToken
        );

        return;
      }

      await config.database.prepare(`
        UPDATE user_settings
        SET current_category_id = ?,
            waiting_for = NULL,
            editing_file_id = NULL
        WHERE chat_id = ?
      `).bind(
        categoryId,
        chatId
      ).run();

      userSetting.current_category_id = categoryId;
      userSetting.waiting_for = null;
      userSetting.editing_file_id = null;

      // 删除分类选择列表
      await deleteCallbackSourceMessage(
        update,
        config
      );

      await sendMessage(
        chatId,
        `✅ 已切换到分类：${escapeHtml(category.name)}`,
        config.tgBotToken
      );

      await sendPanel(
        chatId,
        userSetting,
        config
      );

      return;
    }
    else if (cbData === 'back_to_panel') {
      await answerPromise;

      // 清除可能遗留的等待状态
      await resetWaitingState(
        chatId,
        userSetting,
        config
      );

      // 删除当前带“返回”按钮的子菜单
      await deleteCallbackSourceMessage(
        update,
        config
      );

      // 重新发送主菜单
      await sendPanel(
        chatId,
        userSetting,
        config
      );

      return;
    }
    if (cbData === 'r2_stats') {
      // 管理员权限验证
      if (
        config.tgAdminId &&
        config.tgAdminId.length > 0 &&
        !config.tgAdminId.includes(chatId)
      ) {
        await answerPromise;
        await sendMessage(
          chatId,
          "❌ 你没有权限查看 R2 统计，请联系管理员",
          config.tgBotToken
        );
        return;
      }
      await answerPromise;

  const stats = await config.database.prepare(`
    SELECT COUNT(*) as total_files, SUM(file_size) as total_size
    FROM files
    WHERE chat_id = ? AND storage_type = 'r2'
  `).bind(chatId).first();

  const totalFiles = stats?.total_files || 0;
  const totalSize = stats?.total_size || 0;

  const statsMessage = `📊 您的 R2 存储使用统计
  ─────────────
  📁 R2 文件数: ${totalFiles}
  💾 R2 存储量: ${formatSize(totalSize)}`;

      if (config.buttonCache) {
        config.buttonCache.set(cacheKey, {
          timestamp: Date.now(),
          responseText: statsMessage
        });
      }
      await sendMessage(chatId, statsMessage, config.tgBotToken);
    }
    else if (cbData === 'edit_suffix') {
      await answerPromise;
      const recentFiles = await config.database.prepare(`
        SELECT id, url, fileId, file_name, created_at, storage_type,
               is_chunked, chunk_count
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).bind(chatId).all();
      if (!recentFiles.results || recentFiles.results.length === 0) {
        await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
        return;
      }
      const keyboard = {
        inline_keyboard: recentFiles.results.map(file => {
          const fileName = getStoredDisplayName(file);
          const chunkLabel = Number(file.is_chunked || 0) === 1
            ? ` 🧩${Number(file.chunk_count || 0)}`
            : '';
          return [{ text: `${fileName}${chunkLabel}`, callback_data: `edit_suffix_file_${file.id}` }];
        }).concat([[{ text: "« 返回", callback_data: "back_to_panel" }]])
      };
      await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📝 请选择要修改后缀的文件：",
          reply_markup: keyboard
        })
      });
    }
    else if (cbData.startsWith('edit_suffix_file_')) {
      await answerPromise;
      const fileId = Number(cbData.slice('edit_suffix_file_'.length));
      if (!Number.isInteger(fileId) || fileId <= 0) {
        await sendMessage(chatId, "❌ 文件标识无效", config.tgBotToken);
        return;
      }
      const file = await config.database.prepare(`
        SELECT * FROM files
        WHERE id = ? AND chat_id = ?
        LIMIT 1
      `).bind(fileId, chatId).first();
      if (!file) {
        await sendMessage(chatId, "⚠️ 文件不存在、已被删除或不属于当前用户", config.tgBotToken);
        return;
      }
      await config.database.prepare(`
        UPDATE user_settings
        SET waiting_for = 'new_suffix', editing_file_id = ?
        WHERE chat_id = ?
      `).bind(file.id, chatId).run();
      userSetting.waiting_for = 'new_suffix';
      userSetting.editing_file_id = file.id;
      const fileName = getStoredDisplayName(file);
      const chunkText = Number(file.is_chunked || 0) === 1
        ? `
🧩 这是分片文件，共 ${Number(file.chunk_count || 0)} 片；修改名称不会重新上传分片`
        : '';
      await sendInputPrompt(
        chatId,
        `✏️ 当前文件：${escapeHtml(fileName)}${chunkText}

请输入新的文件名主体（无需输入扩展名）`,
        config
      );
      return;
    }
    else if (cbData.startsWith('delete_file_confirm_')) {
      await answerPromise;
      const fileId = Number(cbData.slice('delete_file_confirm_'.length));
      const file = Number.isInteger(fileId) && fileId > 0
        ? await config.database.prepare(`
            SELECT * FROM files WHERE id = ? AND chat_id = ? LIMIT 1
          `).bind(fileId, chatId).first()
        : null;
      if (!file) {
        await sendMessage(chatId, "⚠️ 文件不存在、已被删除或不属于当前用户", config.tgBotToken);
        return;
      }
      const chunkText = Number(file.is_chunked || 0) === 1
        ? `
🧩 将同时删除 ${Number(file.chunk_count || 0)} 个分片和 1 个清单文件`
        : '';
      await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `⚠️ 确定删除“${getStoredDisplayName(file)}”吗？${chunkText}

删除后直链将立即失效`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 确认删除', callback_data: `delete_file_do_${file.id}` },
              { text: '取消', callback_data: 'back_to_panel' }
            ]]
          }
        })
      });
      return;
    }
    else if (cbData.startsWith('delete_file_do_')) {
      await answerPromise;
      const fileId = Number(cbData.slice('delete_file_do_'.length));
      const file = Number.isInteger(fileId) && fileId > 0
        ? await config.database.prepare(`
            SELECT * FROM files WHERE id = ? AND chat_id = ? LIMIT 1
          `).bind(fileId, chatId).first()
        : null;
      if (!file) {
        await sendMessage(chatId, "⚠️ 文件不存在、已被删除或不属于当前用户", config.tgBotToken);
        return;
      }
      const fileName = getStoredDisplayName(file);
      const deleted = await deleteStoredFileRecord(file, config);
      await deleteCallbackSourceMessage(update, config);
      const warning = deleted.failedTelegramMessages.length
        ? `
⚠️ ${deleted.failedTelegramMessages.length} 条 Telegram 存储消息未能立即删除，但文件记录和直链已清理`
        : '';
      await sendMessage(
        chatId,
        `✅ 已删除：${escapeHtml(fileName)}
🧩 清理分片：${deleted.deletedChunkRows} 个${warning}`,
        config.tgBotToken
      );
      await sendPanel(chatId, userSetting, config);
      return;
    }
    else if (cbData === 'recent_files') {
      const recentFilesPromise = config.database.prepare(`
        SELECT id, url, created_at, file_name, file_size, storage_type,
               is_chunked, chunk_count
        FROM files
        WHERE chat_id = ?
        ORDER BY created_at DESC
        LIMIT 10
      `).bind(chatId).all();
      await answerPromise;
      const recentFiles = await recentFilesPromise;
      if (!recentFiles.results || recentFiles.results.length === 0) {
        await sendMessage(chatId, "⚠️ 您还没有上传过文件", config.tgBotToken);
        return;
      }
      const filesList = recentFiles.results.map((file, i) => {
        const fileName = getStoredDisplayName(file);
        const date = formatDate(file.created_at);
        const storageEmoji = file.storage_type === 'r2' ? '☁️' : '✈️';
        const chunkText = Number(file.is_chunked || 0) === 1
          ? ` · 🧩 ${Number(file.chunk_count || 0)}片`
          : '';
        return `${i + 1}. ${fileName}\n   📦 ${formatSize(file.file_size || 0)}${chunkText}\n   📅 ${date} ${storageEmoji}\n   🔗 ${file.url}`;
      }).join('\n\n');
      const actionRows = recentFiles.results.map((file, index) => ([
        { text: `🔗 ${index + 1}`, url: file.url },
        { text: `✏️ ${index + 1}`, callback_data: `edit_suffix_file_${file.id}` },
        { text: `🗑️ ${index + 1}`, callback_data: `delete_file_confirm_${file.id}` }
      ]));
      const keyboard = {
        inline_keyboard: actionRows.concat([
          [{ text: "« 返回", callback_data: "back_to_panel" }]
        ])
      };
      await deleteCallbackSourceMessage(
        update,
        config
      );
      if (config.buttonCache) {
         config.buttonCache.set(cacheKey, {
           timestamp: Date.now(),
           replyText: "📋 您最近上传的文件：\n\n" + filesList,
           replyMarkup: keyboard,
           disablePreview: true
         });
      }
      await fetch(telegramMethodUrl(config.tgBotToken, 'sendMessage', config), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: "📋 您最近上传的文件：\n\n" + filesList,
          reply_markup: keyboard,
          disable_web_page_preview: true
        })
      });
    }
    else if (cbData === 'edit_suffix_input') {
      await answerPromise;

      await config.database.prepare(`
        UPDATE user_settings
        SET waiting_for = ?,
            editing_file_id = NULL
        WHERE chat_id = ?
      `).bind(
        'edit_suffix_input_file',
        chatId
      ).run();

      userSetting.waiting_for =
        'edit_suffix_input_file';

      userSetting.editing_file_id = null;

      await sendInputPrompt(
        chatId,
        "✏️ 请输入要修改后缀的文件完整名称，" +
        "必须包含扩展名；也可以输入完整 URL",
        config
      );

      return;
    }
    else if (cbData === 'delete_file_input') {
      await answerPromise;

      await config.database.prepare(`
        UPDATE user_settings
        SET waiting_for = ?,
            editing_file_id = NULL
        WHERE chat_id = ?
      `).bind(
        'delete_file_input',
        chatId
      ).run();

      userSetting.waiting_for =
        'delete_file_input';

      userSetting.editing_file_id = null;

      await sendInputPrompt(
        chatId,
        "🗑️ 请输入要删除的文件完整名称，" +
        "必须包含扩展名；也可以输入完整 URL",
        config
      );

      return;
    }
    else if (userSetting.waiting_for === 'edit_suffix_input_file' && update.message.text) {
      console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
      try { await answerPromise; } catch {}
      return;
    }
    else if (userSetting.waiting_for === 'edit_suffix_input_new' && update.message.text && userSetting.editing_file_id) {
      console.error('错误: 不应该执行到这里，修改后缀的逻辑已移至handleTelegramWebhook函数');
      try { await answerPromise; } catch {}
      return;
    }
  } catch (error) {
    console.error('处理回调查询时出错:', error);
    try { await answerPromise; } catch {}
    await sendMessage(chatId, `❌ 处理请求时出错: ${error.message}`, config.tgBotToken);
  }
}

const TELEGRAM_MANIFEST_MAGIC = 'tgstate-blob';

function normalizeUploadId(value) {
  const uploadId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{16,80}$/.test(uploadId) ? uploadId : null;
}

function sanitizeTelegramFileName(fileName, fallback = 'file.bin') {
  const value = String(fileName || fallback)
    .replace(/[\\/\0\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (value || fallback).slice(0, 180);
}

function getTelegramChunkSizeBytes(config) {
  return Math.floor(Number(config.telegramChunkSizeMB || 19) * 1024 * 1024);
}

function shouldUseTelegramChunks(fileSize, config) {
  return Number(fileSize || 0) > getTelegramChunkSizeBytes(config);
}

function chooseTelegramUploadMode(mimeType, fileSize, config) {
  const size = Number(fileSize || 0);
  const mime = String(mimeType || 'application/octet-stream').toLowerCase();
  const photoLimit = Number(config.telegramPhotoLimitMB || 10) * 1024 * 1024;

  if (
    mime.startsWith('image/') &&
    !['image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(mime) &&
    size <= photoLimit
  ) {
    return { method: 'sendPhoto', field: 'photo' };
  }
  if (mime.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  if (mime.startsWith('audio/')) return { method: 'sendAudio', field: 'audio' };
  return { method: 'sendDocument', field: 'document' };
}

function extractTelegramUploadedFile(result, field) {
  let fileId = null;
  if (field === 'photo') {
    const photos = result.photo || [];
    fileId = photos.length ? photos[photos.length - 1].file_id : null;
  } else if (field === 'video') {
    fileId = result.video && result.video.file_id;
  } else if (field === 'audio') {
    fileId = result.audio && result.audio.file_id;
  } else {
    fileId = result.document && result.document.file_id;
  }
  return {
    fileId,
    messageId: result.message_id
  };
}

async function uploadBlobToTelegram(
  blob,
  fileName,
  mimeType,
  config,
  options = {}
) {
  if (!config.tgBotToken || !config.tgStorageChatId) {
    throw new Error('未配置 Telegram 存储参数 (TG_BOT_TOKEN 和 TG_STORAGE_CHAT_ID)');
  }

  const method = options.method || 'sendDocument';
  const field = options.field || 'document';
  const safeName = sanitizeTelegramFileName(fileName);
  const formData = new FormData();
  formData.append('chat_id', config.tgStorageChatId);
  formData.append(field, blob, safeName);
  if (options.caption && field !== 'photo') {
    formData.append('caption', String(options.caption).slice(0, 1024));
  }

  const response = await fetch(
    telegramMethodUrl(config.tgBotToken, method, config),
    { method: 'POST', body: formData }
  );
  const responseText = await response.text();
  let data = null;
  try {
    data = JSON.parse(responseText);
  } catch (_) {}

  if (!response.ok || !data || !data.ok) {
    const description = data && data.description ? data.description : responseText;
    throw new Error(`Telegram ${method} 失败: ${description || response.status}`);
  }

  const uploaded = extractTelegramUploadedFile(data.result, field);
  if (!uploaded.fileId || !uploaded.messageId) {
    throw new Error(`Telegram ${method} 成功但未返回有效 file_id/message_id`);
  }

  return uploaded;
}

async function uploadSingleFileToTelegram(blob, fileName, mimeType, config) {
  const size = Number(blob.size || 0);
  const mode = chooseTelegramUploadMode(mimeType, size, config);
  const caption = `File: ${sanitizeTelegramFileName(fileName)}\nType: ${mimeType || 'application/octet-stream'}\nSize: ${formatSize(size)}`;

  try {
    return await uploadBlobToTelegram(blob, fileName, mimeType, config, {
      ...mode,
      caption
    });
  } catch (error) {
    if (mode.method === 'sendDocument') throw error;
    console.warn(`${mode.method} 失败，改用 sendDocument:`, error.message);
    return uploadBlobToTelegram(blob, fileName, mimeType, config, {
      method: 'sendDocument',
      field: 'document',
      caption
    });
  }
}

async function deleteTelegramStorageMessage(messageId, config) {
  if (!messageId || Number(messageId) <= 0 || !config.tgStorageChatId) return true;
  try {
    const response = await fetch(
      telegramMethodUrl(config.tgBotToken, 'deleteMessage', config),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.tgStorageChatId,
          message_id: Number(messageId)
        })
      }
    );
    const data = await response.json().catch(() => null);
    if (response.ok && data && data.ok) return true;
    const description = data && data.description ? data.description : '';
    if (/message to delete not found|message can't be deleted/i.test(description)) {
      return false;
    }
    console.warn(`删除 Telegram 消息 ${messageId} 失败:`, description || response.status);
    return false;
  } catch (error) {
    console.warn(`删除 Telegram 消息 ${messageId} 出错:`, error.message);
    return false;
  }
}

async function savePendingChunk({
  uploadId,
  chatId,
  chunkIndex,
  totalChunks,
  telegramFileId,
  messageId,
  chunkSize
}, config) {
  const result = await config.database.prepare(`
    INSERT OR IGNORE INTO file_chunks (
      upload_id, file_id, chat_id, chunk_index, total_chunks,
      telegram_file_id, message_id, chunk_size, created_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    uploadId,
    chatId,
    chunkIndex,
    totalChunks,
    telegramFileId,
    messageId,
    chunkSize,
    Date.now()
  ).run();

  if (!result.meta || Number(result.meta.changes || 0) === 0) {
    const existing = await config.database.prepare(`
      SELECT telegram_file_id, message_id, chunk_size
      FROM file_chunks
      WHERE upload_id = ? AND chat_id = ? AND chunk_index = ?
      LIMIT 1
    `).bind(uploadId, chatId, chunkIndex).first();
    if (existing) {
      await deleteTelegramStorageMessage(messageId, config);
      return existing;
    }
    throw new Error('保存分片记录失败');
  }

  return {
    telegram_file_id: telegramFileId,
    message_id: messageId,
    chunk_size: chunkSize
  };
}

async function uploadOneTelegramChunk(
  chunk,
  uploadId,
  chunkIndex,
  totalChunks,
  originalFileName,
  chatId,
  config
) {
  const existing = await config.database.prepare(`
    SELECT telegram_file_id, message_id, chunk_size
    FROM file_chunks
    WHERE upload_id = ? AND chat_id = ? AND chunk_index = ?
    LIMIT 1
  `).bind(uploadId, chatId, chunkIndex).first();
  if (existing) return existing;

  const partNumber = String(chunkIndex + 1).padStart(5, '0');
  const safeOriginal = sanitizeTelegramFileName(originalFileName, 'large-file.bin');
  const partName = `${safeOriginal}.part${partNumber}`;
  const uploaded = await uploadBlobToTelegram(
    chunk,
    partName,
    'application/octet-stream',
    config,
    {
      method: 'sendDocument',
      field: 'document',
      caption: `blob [${chunkIndex + 1}/${totalChunks}] - ${safeOriginal}`
    }
  );

  return savePendingChunk({
    uploadId,
    chatId,
    chunkIndex,
    totalChunks,
    telegramFileId: uploaded.fileId,
    messageId: uploaded.messageId,
    chunkSize: Number(chunk.size || 0)
  }, config);
}

async function abortPendingChunkUpload(uploadId, chatId, config) {
  const validUploadId = normalizeUploadId(uploadId);
  if (!validUploadId) return 0;

  const result = await config.database.prepare(`
    SELECT id, message_id
    FROM file_chunks
    WHERE upload_id = ? AND chat_id = ? AND file_id IS NULL
    ORDER BY chunk_index
  `).bind(validUploadId, chatId).all();
  const chunks = result.results || [];

  for (const chunk of chunks) {
    await deleteTelegramStorageMessage(chunk.message_id, config);
  }
  await config.database.prepare(`
    DELETE FROM file_chunks
    WHERE upload_id = ? AND chat_id = ? AND file_id IS NULL
  `).bind(validUploadId, chatId).run();
  return chunks.length;
}

async function insertFileRecord(fileData, config) {
  const result = await config.database.prepare(`
    INSERT INTO files (
      url, fileId, message_id, created_at, file_name, file_size,
      mime_type, storage_type, category_id, chat_id,
      is_chunked, chunk_count, upload_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    fileData.url,
    fileData.fileId,
    fileData.messageId,
    fileData.createdAt || Date.now(),
    fileData.fileName,
    Number(fileData.fileSize || 0),
    fileData.mimeType || 'application/octet-stream',
    fileData.storageType || 'telegram',
    fileData.categoryId || null,
    fileData.chatId,
    fileData.isChunked ? 1 : 0,
    Number(fileData.chunkCount || 0),
    fileData.uploadId || null
  ).run();

  let fileRowId = result.meta && result.meta.last_row_id;
  if (!fileRowId && fileData.uploadId) {
    const row = await config.database.prepare(`
      SELECT id FROM files WHERE upload_id = ? LIMIT 1
    `).bind(fileData.uploadId).first();
    fileRowId = row && row.id;
  }
  if (!fileRowId) {
    const row = await config.database.prepare(`
      SELECT id FROM files WHERE url = ? ORDER BY id DESC LIMIT 1
    `).bind(fileData.url).first();
    fileRowId = row && row.id;
  }
  if (!fileRowId) throw new Error('写入文件记录后未能获取文件 ID');
  return Number(fileRowId);
}

async function finalizeChunkedTelegramUpload({
  uploadId,
  chatId,
  fileName,
  fileSize,
  mimeType,
  categoryId,
  key,
  totalChunks
}, config) {
  const validUploadId = normalizeUploadId(uploadId);
  if (!validUploadId) throw new Error('upload_id 格式无效');

  const existingFile = await config.database.prepare(`
    SELECT * FROM files WHERE upload_id = ? AND chat_id = ? LIMIT 1
  `).bind(validUploadId, chatId).first();
  if (existingFile) return existingFile;

  const result = await config.database.prepare(`
    SELECT * FROM file_chunks
    WHERE upload_id = ? AND chat_id = ?
    ORDER BY chunk_index ASC
  `).bind(validUploadId, chatId).all();
  const chunks = result.results || [];

  if (chunks.length !== Number(totalChunks)) {
    throw new Error(`分片不完整：应有 ${totalChunks} 片，实际 ${chunks.length} 片`);
  }
  for (let index = 0; index < chunks.length; index++) {
    if (Number(chunks[index].chunk_index) !== index) {
      throw new Error(`缺少第 ${index + 1} 个分片`);
    }
  }
  const actualSize = chunks.reduce((sum, chunk) => sum + Number(chunk.chunk_size || 0), 0);
  if (actualSize !== Number(fileSize)) {
    throw new Error(`分片总大小不一致：应为 ${fileSize}，实际 ${actualSize}`);
  }

  const safeName = sanitizeTelegramFileName(fileName, 'large-file.bin');
  const manifestText = [
    TELEGRAM_MANIFEST_MAGIC,
    safeName,
    `size${fileSize}`,
    ...chunks.map(chunk => chunk.telegram_file_id)
  ].join('\n');
  const manifestBlob = new Blob([manifestText], { type: 'text/plain;charset=UTF-8' });
  const manifestUpload = await uploadBlobToTelegram(
    manifestBlob,
    'fileAll.txt',
    'text/plain',
    config,
    {
      method: 'sendDocument',
      field: 'document',
      caption: safeName
    }
  );

  const finalKey = key || generateSafeKey(safeName);
  const finalUrl = `https://${config.domain}/${finalKey}`;
  let fileRowId = null;
  try {
    fileRowId = await insertFileRecord({
      url: finalUrl,
      fileId: manifestUpload.fileId,
      messageId: manifestUpload.messageId,
      fileName: safeName,
      fileSize,
      mimeType,
      storageType: 'telegram',
      categoryId,
      chatId,
      isChunked: true,
      chunkCount: chunks.length,
      uploadId: validUploadId
    }, config);

    await config.database.prepare(`
      UPDATE file_chunks
      SET file_id = ?
      WHERE upload_id = ? AND chat_id = ?
    `).bind(fileRowId, validUploadId, chatId).run();

    return await config.database.prepare(
      'SELECT * FROM files WHERE id = ?'
    ).bind(fileRowId).first();
  } catch (error) {
    await deleteTelegramStorageMessage(manifestUpload.messageId, config);
    if (fileRowId) {
      await config.database.prepare('DELETE FROM files WHERE id = ?').bind(fileRowId).run();
    }
    throw error;
  }
}

async function saveTelegramFileFromBlob({
  blob,
  fileName,
  fileSize,
  mimeType,
  categoryId,
  chatId,
  key
}, config) {
  const finalKey = key || generateSafeKey(fileName);
  const finalUrl = `https://${config.domain}/${finalKey}`;

  if (!shouldUseTelegramChunks(fileSize, config)) {
    const uploaded = await uploadSingleFileToTelegram(blob, fileName, mimeType, config);
    await insertFileRecord({
      url: finalUrl,
      fileId: uploaded.fileId,
      messageId: uploaded.messageId,
      fileName,
      fileSize,
      mimeType,
      storageType: 'telegram',
      categoryId,
      chatId,
      isChunked: false,
      chunkCount: 0
    }, config);
    return { url: finalUrl, isChunked: false, chunkCount: 0 };
  }

  const uploadId = crypto.randomUUID().replace(/-/g, '_');
  const chunkSize = getTelegramChunkSizeBytes(config);
  const totalChunks = Math.ceil(Number(fileSize) / chunkSize);
  try {
    for (let index = 0; index < totalChunks; index++) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, Number(fileSize));
      await uploadOneTelegramChunk(
        blob.slice(start, end),
        uploadId,
        index,
        totalChunks,
        fileName,
        chatId,
        config
      );
    }

    const file = await finalizeChunkedTelegramUpload({
      uploadId,
      chatId,
      fileName,
      fileSize,
      mimeType,
      categoryId,
      key: finalKey,
      totalChunks
    }, config);
    return { url: file.url, isChunked: true, chunkCount: totalChunks };
  } catch (error) {
    await abortPendingChunkUpload(uploadId, chatId, config);
    throw error;
  }
}

async function getTelegramFileResponse(fileId, config, rangeStart = null, rangeEnd = null) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const infoResponse = await fetch(
        `${telegramMethodUrl(config.tgBotToken, 'getFile', config)}?file_id=${encodeURIComponent(fileId)}`
      );
      const info = await infoResponse.json();
      if (!infoResponse.ok || !info.ok || !info.result || !info.result.file_path) {
        throw new Error(info.description || `getFile HTTP ${infoResponse.status}`);
      }
      const headers = new Headers();
      if (rangeStart !== null && rangeEnd !== null) {
        headers.set('Range', `bytes=${rangeStart}-${rangeEnd}`);
      }
      const fileResponse = await fetchTelegramBinaryFile(
        fileId,
        info.result.file_path,
        config,
        headers
      );
      if (!fileResponse.ok && fileResponse.status !== 206) {
        throw new Error(`文件下载 HTTP ${fileResponse.status}`);
      }
      return fileResponse;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 300 * attempt));
      }
    }
  }
  throw lastError || new Error('Telegram 文件下载失败');
}

function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };
  let start;
  let end;
  if (match[1] === '' && match[2] !== '') {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? totalSize - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= totalSize) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

async function loadChunkRows(file, config) {
  const result = await config.database.prepare(`
    SELECT chunk_index, telegram_file_id, message_id, chunk_size
    FROM file_chunks
    WHERE file_id = ?
    ORDER BY chunk_index ASC
  `).bind(file.id).all();
  const chunks = result.results || [];
  if (chunks.length) return chunks;

  // 兼容/恢复 tgNetDisc 风格的 fileAll.txt 清单
  const manifestResponse = await getTelegramFileResponse(file.fileId, config);
  const manifestText = await manifestResponse.text();
  const lines = manifestText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== TELEGRAM_MANIFEST_MAGIC || lines.length < 4) {
    throw new Error('分片清单无效，且数据库中没有分片记录');
  }
  let startLine = 2;
  if (lines[startLine] && lines[startLine].startsWith('size')) startLine++;
  const ids = lines.slice(startLine);
  const defaultChunkSize = getTelegramChunkSizeBytes(config);
  const totalSize = Number(file.file_size || 0);
  return ids.map((telegramFileId, index) => ({
    chunk_index: index,
    telegram_file_id: telegramFileId,
    message_id: 0,
    chunk_size: index === ids.length - 1
      ? Math.max(0, totalSize - defaultChunkSize * (ids.length - 1))
      : defaultChunkSize
  }));
}

function buildChunkSelections(chunks, rangeStart, rangeEnd) {
  const selections = [];
  let offset = 0;
  for (const chunk of chunks) {
    const size = Number(chunk.chunk_size || 0);
    const chunkStart = offset;
    const chunkEnd = offset + size - 1;
    offset += size;
    if (chunkEnd < rangeStart || chunkStart > rangeEnd) continue;
    selections.push({
      ...chunk,
      localStart: Math.max(0, rangeStart - chunkStart),
      localEnd: Math.min(size - 1, rangeEnd - chunkStart),
      fullChunk: rangeStart <= chunkStart && rangeEnd >= chunkEnd
    });
  }
  return selections;
}

function createTelegramChunkStream(selections, config) {
  let selectionIndex = 0;
  let currentReader = null;

  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          if (currentReader) {
            const { done, value } = await currentReader.read();
            if (!done) {
              controller.enqueue(value);
              return;
            }
            currentReader = null;
            selectionIndex++;
          }

          if (selectionIndex >= selections.length) {
            controller.close();
            return;
          }

          const selected = selections[selectionIndex];
          const response = await getTelegramFileResponse(
            selected.telegram_file_id,
            config,
            selected.fullChunk ? null : selected.localStart,
            selected.fullChunk ? null : selected.localEnd
          );

          if (!selected.fullChunk && response.status !== 206) {
            // Telegram 若忽略 Range，单片最多 19MB，可安全回退为内存切片
            const buffer = await response.arrayBuffer();
            const sliced = buffer.slice(selected.localStart, selected.localEnd + 1);
            controller.enqueue(new Uint8Array(sliced));
            selectionIndex++;
            return;
          }

          if (!response.body) throw new Error('Telegram 返回了空响应体');
          currentReader = response.body.getReader();
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (currentReader) {
        try { await currentReader.cancel(reason); } catch (_) {}
      }
    }
  });
}

function encodeContentDispositionFileName(fileName) {
  return encodeURIComponent(String(fileName || 'download.bin'))
    .replace(/[!'()*]/g, character =>
      '%' + character.charCodeAt(0).toString(16).toUpperCase()
    );
}

function getStoredDisplayName(file) {
  if (!file) return 'download.bin';
  const candidate = String(file.file_name || '').trim();
  if (candidate) return candidate;
  try {
    return decodeURIComponent(new URL(String(file.url || '')).pathname.split('/').pop()) || 'download.bin';
  } catch (_) {
    return String(file.url || '').split('/').pop() || 'download.bin';
  }
}

function splitStoredFileName(fileName) {
  const safeName = sanitizeTelegramFileName(fileName, 'file.bin');
  const lastDot = safeName.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === safeName.length - 1) {
    return { stem: safeName, extension: '' };
  }
  return {
    stem: safeName.slice(0, lastDot),
    extension: safeName.slice(lastDot + 1)
  };
}

function normalizePublicFileStem(value) {
  let stem = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  stem = stem.replace(/\s+/g, ' ');
  // 用户偶尔会把完整文件名贴进来；只移除与旧文件相同扩展名由调用处处理
  if (!stem) throw new Error('新文件名不能为空');
  if (stem === '.' || stem === '..') throw new Error('新文件名无效');
  if (stem.length > 120) throw new Error('新文件名不能超过 120 个字符');
  return stem;
}

function invalidateStoredFileCache(file, config, extraPaths = []) {
  if (!config || !config.fileCache) return;
  const paths = new Set(extraPaths.filter(Boolean));
  if (file && file.url) {
    try {
      paths.add(decodeURIComponent(new URL(file.url).pathname.split('/').pop()));
    } catch (_) {
      paths.add(String(file.url).split('/').pop());
    }
  }
  for (const path of paths) {
    if (path) config.fileCache.delete(`file:${path}`);
  }
}

async function renameStoredFileRecord(file, requestedStem, config) {
  if (!file || !file.id) throw new Error('文件不存在');
  const oldName = getStoredDisplayName(file);
  const { extension } = splitStoredFileName(oldName);
  let stem = normalizePublicFileStem(requestedStem);
  if (extension && stem.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) {
    stem = stem.slice(0, -(extension.length + 1)).trim();
    if (!stem) throw new Error('新文件名不能为空');
  }
  const newFileName = extension ? `${stem}.${extension}` : stem;
  const encodedPath = encodeURIComponent(newFileName).replace(/%2F/gi, '_');
  const newUrl = `https://${config.domain}/${encodedPath}`;

  const conflict = await config.database.prepare(`
    SELECT id FROM files
    WHERE id != ? AND (url = ? OR file_name = ?)
    LIMIT 1
  `).bind(file.id, newUrl, newFileName).first();
  if (conflict) throw new Error('该文件名或直链已被使用');

  const oldPath = (() => {
    try { return decodeURIComponent(new URL(file.url).pathname.split('/').pop()); }
    catch (_) { return String(file.url || '').split('/').pop(); }
  })();

  let newStorageKey = file.fileId;
  let copiedR2Object = false;
  if (file.storage_type === 'r2' && config.bucket && file.fileId) {
    const object = await config.bucket.get(file.fileId);
    if (!object) throw new Error('R2 中未找到原文件，无法重命名');
    newStorageKey = newFileName;
    if (newStorageKey !== file.fileId) {
      await config.bucket.put(newStorageKey, object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata
      });
      copiedR2Object = true;
    }
  }

  let fileRowUpdated = false;
  try {
    await config.database.prepare(`
      UPDATE files
      SET url = ?, file_name = ?, custom_suffix = ?, fileId = ?
      WHERE id = ?
    `).bind(
      newUrl,
      newFileName,
      stem,
      newStorageKey,
      file.id
    ).run();
    fileRowUpdated = true;

    // 专属大文件页完成后会保存永久直链；改名时同步更新，避免状态页返回旧地址
    await config.database.prepare(`
      UPDATE bot_upload_sessions
      SET result_url = ?, file_name = ?
      WHERE result_file_id = ? AND status = 'completed'
    `).bind(newUrl, newFileName, file.id).run();
  } catch (error) {
    if (fileRowUpdated) {
      try {
        await config.database.prepare(`
          UPDATE files
          SET url = ?, file_name = ?, custom_suffix = ?, fileId = ?
          WHERE id = ?
        `).bind(
          file.url,
          file.file_name || oldName,
          file.custom_suffix || null,
          file.fileId,
          file.id
        ).run();
      } catch (rollbackError) {
        console.error('回滚文件名修改失败:', rollbackError);
      }
    }
    if (copiedR2Object && newStorageKey && newStorageKey !== file.fileId) {
      try { await config.bucket.delete(newStorageKey); } catch (_) {}
    }
    throw error;
  }

  // 数据库已经指向新对象后，旧 R2 对象删除失败不应回滚新名称，避免把记录指向已删除对象
  if (copiedR2Object && file.fileId !== newStorageKey) {
    try {
      await config.bucket.delete(file.fileId);
    } catch (cleanupError) {
      console.warn(`旧 R2 对象 ${file.fileId} 删除失败:`, cleanupError.message);
    }
  }

  invalidateStoredFileCache(file, config, [oldPath, encodedPath, newFileName]);
  return {
    id: Number(file.id),
    url: newUrl,
    fileName: newFileName,
    storageType: file.storage_type,
    isChunked: Number(file.is_chunked || 0) === 1,
    chunkCount: Number(file.chunk_count || 0)
  };
}

async function deleteStoredFileRecord(file, config) {
  if (!file || !file.id) throw new Error('文件不存在');

  const failedTelegramMessages = [];
  let deletedChunkRows = 0;
  let deletedStorageMessages = 0;

  // 先使完成会话中的旧直链失效，避免外键或状态页残留
  await config.database.prepare(`
    UPDATE bot_upload_sessions
    SET status = 'cancelled', result_file_id = NULL, result_url = NULL,
        error_message = '文件已删除'
    WHERE result_file_id = ? OR (upload_id = ? AND upload_id IS NOT NULL)
  `).bind(file.id, file.upload_id || null).run();

  if (file.storage_type === 'telegram') {
    const chunkResult = await config.database.prepare(`
      SELECT id, message_id
      FROM file_chunks
      WHERE file_id = ? OR (upload_id = ? AND ? IS NOT NULL)
      ORDER BY chunk_index ASC
    `).bind(file.id, file.upload_id || null, file.upload_id || null).all();
    const chunks = chunkResult.results || [];
    deletedChunkRows = chunks.length;

    for (const chunk of chunks) {
      if (!chunk.message_id) continue;
      const deleted = await deleteTelegramStorageMessage(chunk.message_id, config);
      if (deleted) deletedStorageMessages++;
      else failedTelegramMessages.push(Number(chunk.message_id));
    }

    if (file.message_id) {
      const manifestDeleted = await deleteTelegramStorageMessage(file.message_id, config);
      if (manifestDeleted) deletedStorageMessages++;
      else failedTelegramMessages.push(Number(file.message_id));
    }

    await config.database.prepare(`
      DELETE FROM file_chunks
      WHERE file_id = ? OR (upload_id = ? AND ? IS NOT NULL)
    `).bind(file.id, file.upload_id || null, file.upload_id || null).run();
  } else if (file.storage_type === 'r2' && config.bucket && file.fileId) {
    await config.bucket.delete(file.fileId);
  }

  await config.database.prepare('DELETE FROM files WHERE id = ?').bind(file.id).run();
  invalidateStoredFileCache(file, config, [getStoredDisplayName(file)]);

  return {
    deleted: true,
    deletedChunkRows,
    deletedStorageMessages,
    failedTelegramMessages
  };
}


function buildBotUploadId(chatId, sourceMessageId, file) {
  const uniquePart = String(
    (file && (file.file_unique_id || file.file_id)) || crypto.randomUUID()
  ).replace(/[^a-zA-Z0-9_-]/g, '_');
  const raw = `bot_${chatId}_${sourceMessageId || Date.now()}_${uniquePart}`;
  return raw.slice(0, 80).padEnd(16, '_');
}

function buildProgressBar(percent, width = 12) {
  const normalized = Math.max(0, Math.min(100, Number(percent || 0)));
  const filled = Math.round((normalized / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const remain = value % 60;
  return remain ? `${minutes} 分 ${remain} 秒` : `${minutes} 分钟`;
}

async function editTelegramTextMessage(chatId, messageId, text, config, replyMarkup = null) {
  if (!messageId) return false;
  const body = {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        telegramMethodUrl(config.tgBotToken, 'editMessageText', config),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      const data = await response.json().catch(() => null);
      if (response.ok && data && data.ok) return true;
      const description = data && data.description ? data.description : '';
      if (/message is not modified/i.test(description)) return true;
      if (data && Number(data.error_code) === 429 && attempt < 3) {
        const retryAfter = Number(data.parameters && data.parameters.retry_after) || 1;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      console.warn('编辑 Telegram 进度消息失败:', description || response.status);
      return false;
    } catch (error) {
      if (attempt >= 3) {
        console.warn('编辑 Telegram 进度消息出错:', error.message);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  return false;
}

function buildUploadCompletedCaption({
  title = '上传完成',
  fileName,
  fileSize,
  url,
  chunkCount = 0,
  includeQrHint = true
}) {
  return `✅ <b>${escapeHtml(title)}</b>\n\n` +
    `📄 文件：${escapeHtml(fileName)}\n` +
    `📦 大小：${formatSize(Number(fileSize || 0))}\n` +
    (Number(chunkCount || 0) > 1
      ? `🧩 分片：${Number(chunkCount)} 个\n`
      : '') +
    `🔗 ${escapeHtml(url)}` +
    (includeQrHint ? '\n\n🔍 扫描二维码访问' : '');
}

async function sendUploadCompletedWithQr({
  chatId,
  title = '上传完成',
  fileName,
  fileSize,
  url,
  chunkCount = 0
}, config) {
  const qrCodeUrl =
    'https://api.qrserver.com/v1/create-qr-code/' +
    `?size=320x320&data=${encodeURIComponent(url)}`;

  const response = await fetch(
    telegramMethodUrl(config.tgBotToken, 'sendPhoto', config),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: qrCodeUrl,
        caption: buildUploadCompletedCaption({
          title,
          fileName,
          fileSize,
          url,
          chunkCount
        }),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🔗 打开文件',
                url
              }
            ]
          ]
        }
      })
    }
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok) {
    throw new Error(
      (data && data.description) ||
      `Telegram sendPhoto 返回 HTTP ${response.status}`
    );
  }
  return data;
}

function createUploadProgressUpdater(chatId, messageId, fileName, totalBytes, config) {
  const startedAt = Date.now();
  let lastEditAt = 0;
  let lastText = '';

  return async function updateProgress({
    phase = '准备中',
    processedBytes = 0,
    completedChunks = 0,
    totalChunks = 0,
    force = false,
    finalUrl = '',
    error = ''
  } = {}) {
    const now = Date.now();
    const total = Math.max(0, Number(totalBytes || 0));
    const processed = Math.max(0, Math.min(total || Number.MAX_SAFE_INTEGER, Number(processedBytes || 0)));
    const percent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
    const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
    const speed = processed / elapsedSeconds;
    const remainingSeconds = speed > 0 && total > processed
      ? (total - processed) / speed
      : 0;

    let text;
    if (error) {
      text = `❌ <b>上传失败</b>\n\n` +
        `📄 ${escapeHtml(fileName)}\n` +
        `⚠️ ${escapeHtml(error)}`;
    } else if (finalUrl) {
      text = `✅ <b>上传完成</b>\n\n` +
        `📄 ${escapeHtml(fileName)}\n` +
        `📦 ${formatSize(total)}\n` +
        (totalChunks > 1 ? `🧩 ${totalChunks} 个分片\n` : '') +
        `🔗 ${escapeHtml(finalUrl)}`;
    } else {
      text = `⏳ <b>${escapeHtml(phase)}</b>\n\n` +
        `📄 ${escapeHtml(fileName)}\n` +
        `${buildProgressBar(percent)} ${percent.toFixed(1)}%\n` +
        `📦 ${formatSize(processed)} / ${formatSize(total)}\n` +
        (totalChunks > 0 ? `🧩 ${completedChunks}/${totalChunks} 分片\n` : '') +
        `🚀 ${formatSize(speed)}/s` +
        (remainingSeconds > 0 ? `\n⏱ 预计剩余 ${formatDuration(remainingSeconds)}` : '');
    }

    if (!force && now - lastEditAt < 1200) return false;
    if (!force && text === lastText) return false;
    lastEditAt = now;
    lastText = text;
    return editTelegramTextMessage(chatId, messageId, text, config);
  };
}

function combineUint8Arrays(parts, totalLength) {
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function* splitResponseBodyIntoBlobs(response, chunkSize, mimeType, onRead) {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (onRead) await onRead(buffer.byteLength);
    for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
      yield new Blob([buffer.subarray(offset, Math.min(offset + chunkSize, buffer.byteLength))], {
        type: mimeType || 'application/octet-stream'
      });
    }
    return;
  }

  const reader = response.body.getReader();
  let parts = [];
  let partLength = 0;
  let totalRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(chunkSize - partLength, value.byteLength - offset);
        parts.push(value.subarray(offset, offset + take));
        partLength += take;
        offset += take;
        totalRead += take;
        if (onRead) await onRead(totalRead);

        if (partLength === chunkSize) {
          yield new Blob([combineUint8Arrays(parts, partLength)], {
            type: mimeType || 'application/octet-stream'
          });
          parts = [];
          partLength = 0;
        }
      }
    }
    if (partLength > 0) {
      yield new Blob([combineUint8Arrays(parts, partLength)], {
        type: mimeType || 'application/octet-stream'
      });
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
}

async function saveTelegramFileFromResponse({
  response,
  uploadId,
  fileName,
  fileSize,
  mimeType,
  categoryId,
  chatId,
  key,
  progress
}, config) {
  const chunkSize = getTelegramChunkSizeBytes(config);
  const totalChunks = Math.max(1, Math.ceil(Number(fileSize) / chunkSize));
  const finalKey = key || generateSafeKey(fileName);
  const finalUrl = `https://${config.domain}/${finalKey}`;

  const existingFile = await config.database.prepare(`
    SELECT * FROM files WHERE upload_id = ? AND chat_id = ? LIMIT 1
  `).bind(uploadId, chatId).first();
  if (existingFile) {
    return {
      url: existingFile.url,
      isChunked: Number(existingFile.is_chunked || 0) === 1,
      chunkCount: Number(existingFile.chunk_count || 0)
    };
  }

  let uploadedBytes = 0;
  let chunkIndex = 0;
  try {
    for await (const chunk of splitResponseBodyIntoBlobs(
      response,
      chunkSize,
      mimeType,
      async totalRead => {
        if (progress) {
          await progress({
            phase: `读取并切分第 ${Math.min(chunkIndex + 1, totalChunks)}/${totalChunks} 片`,
            processedBytes: Math.max(uploadedBytes, totalRead),
            completedChunks: chunkIndex,
            totalChunks
          });
        }
      }
    )) {
      if (totalChunks === 1) {
        if (progress) {
          await progress({
            phase: '正在写入 Telegram 存储',
            processedBytes: chunk.size,
            completedChunks: 0,
            totalChunks: 1,
            force: true
          });
        }
        // 机器人收到的原文件必须按 document 保存，避免 sendPhoto 重新压缩图片
        const uploaded = await uploadBlobToTelegram(
          chunk,
          fileName,
          mimeType,
          config,
          {
            method: 'sendDocument',
            field: 'document',
            caption: `File: ${sanitizeTelegramFileName(fileName)}\nSize: ${formatSize(fileSize)}`
          }
        );
        await insertFileRecord({
          url: finalUrl,
          fileId: uploaded.fileId,
          messageId: uploaded.messageId,
          fileName,
          fileSize,
          mimeType,
          storageType: 'telegram',
          categoryId,
          chatId,
          isChunked: false,
          chunkCount: 0,
          uploadId
        }, config);
        return { url: finalUrl, isChunked: false, chunkCount: 0 };
      }

      if (progress) {
        await progress({
          phase: `正在上传第 ${chunkIndex + 1}/${totalChunks} 片`,
          processedBytes: Math.max(uploadedBytes, Math.min(fileSize, uploadedBytes + chunk.size)),
          completedChunks: chunkIndex,
          totalChunks
        });
      }
      await uploadOneTelegramChunk(
        chunk,
        uploadId,
        chunkIndex,
        totalChunks,
        fileName,
        chatId,
        config
      );
      uploadedBytes += chunk.size;
      chunkIndex++;
      if (progress) {
        await progress({
          phase: '分片上传中',
          processedBytes: uploadedBytes,
          completedChunks: chunkIndex,
          totalChunks,
          force: true
        });
      }
    }

    if (chunkIndex !== totalChunks) {
      throw new Error(`分片数量不一致：预计 ${totalChunks}，实际 ${chunkIndex}`);
    }

    if (progress) {
      await progress({
        phase: '正在生成分片清单',
        processedBytes: fileSize,
        completedChunks: totalChunks,
        totalChunks,
        force: true
      });
    }
    const fileRow = await finalizeChunkedTelegramUpload({
      uploadId,
      chatId,
      fileName,
      fileSize,
      mimeType,
      categoryId,
      key: finalKey,
      totalChunks
    }, config);
    return { url: fileRow.url, isChunked: true, chunkCount: totalChunks };
  } catch (error) {
    await abortPendingChunkUpload(uploadId, chatId, config);
    throw error;
  }
}

async function handleMediaUpload(
  chatId,
  file,
  isDocument,
  config,
  userSetting,
  sourceMessageId = null
) {
  const declaredSize = Number(file && file.file_size || 0);

  // 临时文件名

  let fileName = sanitizeTelegramFileName(
    file && file.file_name,
    `telegram_${sourceMessageId || Date.now()}.bin`
  );

  const processingMessage = await sendMessage(
    chatId,
    `⏳ <b>准备上传</b>\n\n📄 ${escapeHtml(fileName)}\n${buildProgressBar(0)} 0.0%`,
    config.tgBotToken
  );
  const processingMessageId = processingMessage && processingMessage.result
    ? processingMessage.result.message_id
    : null;

  const uploadId = buildBotUploadId(chatId, sourceMessageId, file);
  let progress = createUploadProgressUpdater(
    chatId,
    processingMessageId,
    fileName,
    declaredSize,
    config
  );

  try {
    if (!file || !file.file_id) throw new Error('消息中没有有效的 Telegram file_id');
    if (declaredSize > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过 ${config.maxSizeMB}MB 业务限制`);
    }

    const cloudDownloadLimit = 20 * 1024 * 1024;
    if (!config.allowLargeBotDownloads && declaredSize > cloudDownloadLimit) {
      throw new Error(`文件超出官方限制`);
    }

    // 检查是否已存在
    const existingFile = await config.database.prepare(`
      SELECT * FROM files WHERE upload_id = ? AND chat_id = ? LIMIT 1
    `).bind(uploadId, chatId).first();
    if (existingFile) {
      const existingSize = Number(existingFile.file_size || declaredSize);
      const existingChunks = Number(existingFile.chunk_count || 0);
      await progress({
        phase: '正在生成二维码',
        processedBytes: existingSize,
        completedChunks: existingChunks || 1,
        totalChunks: Math.max(1, existingChunks),
        force: true
      });
      try {
        await sendUploadCompletedWithQr({
          chatId,
          fileName: existingFile.file_name || fileName,
          fileSize: existingSize,
          url: existingFile.url,
          chunkCount: existingChunks
        }, config);
        await deleteTelegramMessage(chatId, processingMessageId, config);
      } catch (notifyError) {
        console.warn('发送合并上传完成消息失败:', notifyError.message);
        await progress({
          processedBytes: existingSize,
          completedChunks: existingChunks || 1,
          totalChunks: Math.max(1, existingChunks),
          finalUrl: existingFile.url,
          force: true
        });
      }
      return;
    }

    // 获取 Telegram 文件信息
    await progress({ phase: '正在获取 Telegram 文件信息', force: true });
    const fileInfoResponse = await fetch(
      `${telegramMethodUrl(config.tgBotToken, 'getFile', config)}?file_id=${encodeURIComponent(file.file_id)}`
    );
    const data = await fileInfoResponse.json().catch(() => null);
    if (!fileInfoResponse.ok || !data || !data.ok || !data.result || !data.result.file_path) {
      throw new Error(`获取文件路径失败: ${(data && data.description) || fileInfoResponse.status}`);
    }

    const actualSize = Number(data.result.file_size || declaredSize || 0);
    if (!actualSize) throw new Error('Telegram 未返回有效文件大小');
    if (!config.allowLargeBotDownloads && actualSize > cloudDownloadLimit) {
      throw new Error(`文件为 ${formatSize(actualSize)}，超过官方限制；`);
    }
    if (actualSize > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过 ${config.maxSizeMB}MB 业务限制`);
    }

    // 根据 file_path 修正文件名和 MIME 类型
    const filePath = data.result.file_path;
    const filePathExt = (String(filePath).split('.').pop() || '').toLowerCase();

    let mimeType = file.mime_type || 'application/octet-stream';
    if (filePathExt) {
      const guessedMime = getContentType(filePathExt);
      if (guessedMime !== 'application/octet-stream') {
        mimeType = guessedMime;
      }
    }
    let ext = filePathExt;
    if (!ext) ext = getExtensionFromMime(mimeType);
    if (!ext) ext = 'bin';

    // 修正文件名
    if (!file.file_name) {
      if (file.video_note) {
        fileName = `video_note_${Date.now()}.${ext}`;
      } else if (file.voice) {
        fileName = `voice_message_${Date.now()}.${ext}`;
      } else if (file.audio) {
        fileName = (file.audio.title || `audio_${Date.now()}`) + `.${ext}`;
      } else if (file.video) {
        fileName = `video_${Date.now()}.${ext}`;
      } else if (file.photo) {
        fileName = `photo_${Date.now()}.${ext}`;
      } else {
        fileName = `file_${Date.now()}.${ext}`;
      }
    } else {
      // 有原始文件名，但可能缺扩展名
      if (!file.file_name.includes('.')) {
        fileName = `${file.file_name}.${ext}`;
      } else {
        fileName = file.file_name;
      }
    }

    // 重新创建进度更新器
    progress = createUploadProgressUpdater(
      chatId,
      processingMessageId,
      fileName,
      actualSize,
      config
    );
    await progress({ phase: '正在下载并准备分片', force: true });

    // 获取文件内容并存储
    const fileResponse = await fetchTelegramBinaryFile(
      file.file_id,
      filePath,
      config
    );
    if (!fileResponse.ok) {
      throw new Error(`获取文件内容失败: HTTP ${fileResponse.status}`);
    }

    const storageType = userSetting && userSetting.storage_type
      ? userSetting.storage_type
      : 'telegram';
    const categoryId = await (async () => {
      if (userSetting && userSetting.current_category_id) {
        return userSetting.current_category_id;
      }
      let defaultCategory = await config.database.prepare(
        'SELECT id FROM categories WHERE name = ?'
      ).bind('默认分类').first();
      if (!defaultCategory) {
        const result = await config.database.prepare(
          'INSERT INTO categories (name, created_at) VALUES (?, ?)'
        ).bind('默认分类', Date.now()).run();
        defaultCategory = { id: result.meta && result.meta.last_row_id };
      }
      return defaultCategory && defaultCategory.id;
    })();

    const key = generateSafeKey(fileName);
    let saved;
    if (storageType === 'r2' && config.bucket) {
      await progress({
        phase: '正在读取文件并写入 R2',
        processedBytes: Math.min(actualSize, Math.floor(actualSize * 0.25)),
        totalChunks: 1,
        completedChunks: 0,
        force: true
      });
      const r2Buffer = await fileResponse.arrayBuffer();
      await progress({
        phase: '正在写入 R2 存储',
        processedBytes: actualSize,
        totalChunks: 1,
        completedChunks: 0,
        force: true
      });
      await config.bucket.put(key, r2Buffer, {
        httpMetadata: { contentType: mimeType }
      });
      const finalUrl = `https://${config.domain}/${key}`;
      await insertFileRecord({
        url: finalUrl,
        fileId: key,
        messageId: -1,
        fileName,
        fileSize: actualSize,
        mimeType,
        storageType: 'r2',
        categoryId,
        chatId,
        isChunked: false,
        chunkCount: 0,
        uploadId
      }, config);
      saved = { url: finalUrl, isChunked: false, chunkCount: 0 };
    } else {
      saved = await saveTelegramFileFromResponse({
        response: fileResponse,
        uploadId,
        fileName,
        fileSize: actualSize,
        mimeType,
        categoryId,
        chatId,
        key,
        progress
      }, config);
    }

    await progress({
      phase: '正在生成二维码',
      processedBytes: actualSize,
      completedChunks: saved.chunkCount || 1,
      totalChunks: saved.chunkCount || 1,
      force: true
    });

    try {
      await sendUploadCompletedWithQr({
        chatId,
        fileName,
        fileSize: actualSize,
        url: saved.url,
        chunkCount: saved.chunkCount || 0
      }, config);
      await deleteTelegramMessage(chatId, processingMessageId, config);
    } catch (notifyError) {
      console.warn('发送合并上传完成消息失败:', notifyError.message);
      const edited = await progress({
        processedBytes: actualSize,
        completedChunks: saved.chunkCount || 1,
        totalChunks: saved.chunkCount || 1,
        finalUrl: saved.url,
        force: true
      });
      if (!edited) {
        await sendMessage(
          chatId,
          buildUploadCompletedCaption({
            fileName,
            fileSize: actualSize,
            url: saved.url,
            chunkCount: saved.chunkCount || 0,
            includeQrHint: false
          }),
          config.tgBotToken
        );
      }
    }
  } catch (error) {
    console.error('Error handling media upload:', error);
    const edited = await progress({ error: error.message, force: true });
    if (!edited) {
      await sendMessage(chatId, `❌ 上传失败: ${escapeHtml(error.message)}`, config.tgBotToken);
    }
  }
}

async function getTelegramFileUrl(fileId, botToken, config) {
  const response = await fetch(`${telegramMethodUrl(botToken, 'getFile', config)}?file_id=${encodeURIComponent(fileId)}`);
  const data = await response.json();
  if (!data.ok) throw new Error('获取文件路径失败');
  const filePath = data.result.file_path;
  const fileName = filePath.split('/').pop();
  const timestamp = Date.now();
  const fileExt = fileName.split('.').pop();
  const newFileName = `${timestamp}.${fileExt}`;
  if (config && config.domain) {
    return `https://${config.domain}/${newFileName}`;
  } else {
    return telegramFileDownloadUrl(botToken, filePath, config);
  }
}
function authenticate(request, config) {
  if (!config.enableAuth) {
    console.log('[Auth] Authentication disabled.');
    return true;
  }
  if (!config.username || !config.password) {
    console.error("[Auth] FAILED: Missing USERNAME or PASSWORD configuration while auth is enabled.");
    return false;
  }
  const cookies = request.headers.get("Cookie") || "";
  const authToken = cookies.match(/auth_token=([^;]+)/);
  if (!authToken) {
    console.log('[Auth] FAILED: No auth_token cookie found.');
    return false;
  }
  try {
    const tokenData = JSON.parse(atob(authToken[1]));
    const now = Date.now();
    if (now > tokenData.expiration) {
      console.log("[Auth] FAILED: Token expired.");
      return false;
    }
    if (tokenData.username !== config.username) {
      console.log("[Auth] FAILED: Token username mismatch.");
      return false;
    }
    console.log('[Auth] SUCCESS: Valid token found.');
    return true;
  } catch (error) {
    console.error("[Auth] FAILED: Error validating token:", error);
    return false;
  }
}
async function handleAuthRequest(request, config) {
  if (config.enableAuth) {
    const isAuthenticated = authenticate(request, config);
    if (!isAuthenticated) {
      return handleLoginRequest(request, config);
    }
    return handleUploadRequest(request, config);
  }
  return handleUploadRequest(request, config);
}
async function handleLoginRequest(request, config) {
  if (request.method === 'POST') {
    const { username, password } = await request.json();
    if (username === config.username && password === config.password) {
      const expirationDate = new Date();
      const cookieDays = config.cookie || 7;
      expirationDate.setDate(expirationDate.getDate() + cookieDays);
      const expirationTimestamp = expirationDate.getTime();
      const tokenData = JSON.stringify({
        username: config.username,
        expiration: expirationTimestamp
      });
      const token = btoa(tokenData);
      const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${expirationDate.toUTCString()}`;
      return new Response("登录成功", {
        status: 200,
        headers: {
          "Set-Cookie": cookie,
          "Content-Type": "text/plain"
        }
      });
    }
    return new Response("认证失败", { status: 401 });
  }
  const html = generateLoginPage();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
  });
}
async function handleCreateCategoryRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { name } = await request.json();
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return new Response(JSON.stringify({ status: 0, msg: "分类名称不能为空" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const categoryName = name.trim();
    const time = Date.now();
    const existingCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
    if (existingCategory) {
      return new Response(JSON.stringify({ status: 0, msg: `分类 "${categoryName}" 已存在，请选择一个不同的名称！` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
      .bind(categoryName, time).run();
    const category = await config.database.prepare('SELECT id FROM categories WHERE name = ?').bind(categoryName).first();
    return new Response(JSON.stringify({ status: 1, msg: "分类创建成功", category: { id: category.id, name: categoryName } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 0, msg: `创建分类失败：${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
async function handleDeleteCategoryRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return new Response(JSON.stringify({ status: 0, msg: "未授权" }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const { id } = await request.json();
    if (!id || isNaN(id)) {
      return new Response(JSON.stringify({ status: 0, msg: "分类ID无效" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const isDefaultCategory = await config.database.prepare('SELECT id FROM categories WHERE id = ? AND name = ?')
      .bind(id, '默认分类').first();
    if (isDefaultCategory) {
      return new Response(JSON.stringify({ status: 0, msg: "默认分类不能删除" }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const category = await config.database.prepare('SELECT name FROM categories WHERE id = ?').bind(id).first();
    if (!category) {
      return new Response(JSON.stringify({ status: 0, msg: "分类不存在" }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const defaultCategory = await config.database.prepare('SELECT id FROM categories WHERE name = ?')
      .bind('默认分类').first();
    let defaultCategoryId;
    if (!defaultCategory) {
      const result = await config.database.prepare('INSERT INTO categories (name, created_at) VALUES (?, ?)')
        .bind('默认分类', Date.now()).run();
      defaultCategoryId = result.meta && result.meta.last_row_id ? result.meta.last_row_id : null;
      console.log('创建了新的默认分类，ID:', defaultCategoryId);
    } else {
      defaultCategoryId = defaultCategory.id;
    }
    if (defaultCategoryId) {
      await config.database.prepare('UPDATE files SET category_id = ? WHERE category_id = ?')
        .bind(defaultCategoryId, id).run();
      await config.database.prepare('UPDATE user_settings SET current_category_id = ? WHERE current_category_id = ?')
        .bind(defaultCategoryId, id).run();
    } else {
      await config.database.prepare('UPDATE files SET category_id = NULL WHERE category_id = ?').bind(id).run();
      await config.database.prepare('UPDATE user_settings SET current_category_id = NULL WHERE current_category_id = ?').bind(id).run();
    }
    await config.database.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ 
      status: 1, 
      msg: `分类 "${category.name}" 删除成功${defaultCategoryId ? '，相关文件已移至默认分类' : ''}` 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('删除分类失败:', error);
    return new Response(JSON.stringify({ status: 0, msg: `删除分类失败：${error.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

const LARGE_UPLOAD_SESSION_STATUS = Object.freeze({
  PENDING: 'pending',
  UPLOADING: 'uploading',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed'
});

// 相邻两个成功分片之间最多允许间隔 10 分钟
// 该值按需求固定，不受 UPDATE_TIME（临时页面入口有效期）影响
const LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES = 10;
const LARGE_UPLOAD_CHUNK_TIMEOUT_MS =
  LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES * 60 * 1000;

function getPublicOrigin(config) {
  const value = String(config && config.domain || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function createSecureTokenHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}

function normalizeLargeUploadToken(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function getLargeUploadSessionByToken(token, config) {
  const validToken = normalizeLargeUploadToken(token);
  if (!validToken) return null;
  const tokenHash = await sha256Hex(validToken);
  return config.database.prepare(`
    SELECT *
    FROM bot_upload_sessions
    WHERE token_hash = ?
    LIMIT 1
  `).bind(tokenHash).first();
}

function isLargeUploadSessionExpired(session) {
  return !session || Number(session.expires_at || 0) <= Date.now();
}

function mayContinueLargeUploadSession(session) {
  if (!session) return false;
  return [
    LARGE_UPLOAD_SESSION_STATUS.UPLOADING,
    LARGE_UPLOAD_SESSION_STATUS.FINALIZING,
    LARGE_UPLOAD_SESSION_STATUS.COMPLETED
  ].includes(String(session.status || ''));
}

function isLargeUploadSessionCancelled(session) {
  return Boolean(
    session &&
    String(session.status || '') === LARGE_UPLOAD_SESSION_STATUS.CANCELLED
  );
}

async function createLargeUploadSession(chatId, userSetting, config) {
  const token = createSecureTokenHex(32);
  const tokenHash = await sha256Hex(token);
  const uploadId = crypto.randomUUID().replace(/-/g, '_');
  const now = Date.now();
  const expiresAt = now + Number(config.updateTimeMinutes || 20) * 60 * 1000;
  const categoryId = Number(userSetting && userSetting.current_category_id) || null;

  // 每次重新发送主菜单时废弃该用户尚未开始的旧入口；已开始/已完成任务不受影响
  await config.database.prepare(`
    DELETE FROM bot_upload_sessions
    WHERE chat_id = ? AND status = ?
  `).bind(chatId, LARGE_UPLOAD_SESSION_STATUS.PENDING).run();

  await config.database.prepare(`
    INSERT INTO bot_upload_sessions (
      token_hash, chat_id, upload_id, category_id, status,
      created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tokenHash,
    String(chatId),
    uploadId,
    categoryId,
    LARGE_UPLOAD_SESSION_STATUS.PENDING,
    now,
    expiresAt
  ).run();

  return {
    token,
    uploadId,
    expiresAt,
    url: `${getPublicOrigin(config)}/large-upload?token=${encodeURIComponent(token)}`
  };
}

function largeUploadJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store'
    }
  });
}

function getLargeUploadTokenFromRequest(request, bodyOrForm = null) {
  const requestUrl = new URL(request.url);
  return normalizeLargeUploadToken(
    requestUrl.searchParams.get('token') ||
    (bodyOrForm && typeof bodyOrForm.get === 'function' ? bodyOrForm.get('token') : null) ||
    (bodyOrForm && bodyOrForm.token)
  );
}

async function getLargeUploadProgress(session, config) {
  const result = await config.database.prepare(`
    SELECT
      COUNT(*) AS uploaded_chunks,
      COALESCE(SUM(chunk_size), 0) AS uploaded_bytes,
      MAX(created_at) AS last_chunk_at
    FROM file_chunks
    WHERE upload_id = ? AND chat_id = ?
  `).bind(session.upload_id, session.chat_id).first();

  const indexesResult = await config.database.prepare(`
    SELECT chunk_index
    FROM file_chunks
    WHERE upload_id = ? AND chat_id = ?
    ORDER BY chunk_index ASC
  `).bind(session.upload_id, session.chat_id).all();

  return {
    uploadedChunks: Number(result && result.uploaded_chunks || 0),
    uploadedBytes: Number(result && result.uploaded_bytes || 0),
    uploadedIndexes: (indexesResult.results || []).map(row => Number(row.chunk_index)),
    lastChunkAt: Number(result && result.last_chunk_at || 0)
  };
}

async function cancelLargeUploadSessionForChunkTimeout(session, config) {
  if (!session || String(session.status || '') !== LARGE_UPLOAD_SESSION_STATUS.UPLOADING) {
    return { session, cancelled: false, deletedChunks: 0 };
  }

  const progress = await getLargeUploadProgress(session, config);
  const totalChunks = Number(session.total_chunks || 0);

  // 未成功上传首片时由 UPDATE_TIME 控制入口有效期；所有分片都已到齐时
  // 不再执行“分片间隔”取消，允许进入最终生成直链阶段
  if (
    progress.uploadedChunks <= 0 ||
    !progress.lastChunkAt ||
    (totalChunks > 0 && progress.uploadedChunks >= totalChunks) ||
    Date.now() - progress.lastChunkAt <= LARGE_UPLOAD_CHUNK_TIMEOUT_MS
  ) {
    return { session, cancelled: false, deletedChunks: 0, progress };
  }

  const reason =
    `相邻分片上传间隔超过 ${LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES} 分钟，` +
    '任务已取消，已上传分片已删除';

  // 先原子地把任务改为 cancelled，阻止并发的下一片或完成请求继续落库
  const updateResult = await config.database.prepare(`
    UPDATE bot_upload_sessions
    SET status = ?, error_message = ?, uploaded_chunks = 0, uploaded_bytes = 0
    WHERE id = ? AND status = ?
  `).bind(
    LARGE_UPLOAD_SESSION_STATUS.CANCELLED,
    reason,
    session.id,
    LARGE_UPLOAD_SESSION_STATUS.UPLOADING
  ).run();

  if (!updateResult.meta || Number(updateResult.meta.changes || 0) <= 0) {
    const current = await config.database.prepare(
      'SELECT * FROM bot_upload_sessions WHERE id = ? LIMIT 1'
    ).bind(session.id).first();
    return { session: current || session, cancelled: false, deletedChunks: 0 };
  }

  // 删除该 upload_id 下尚未绑定正式文件的全部 Telegram 分片与 D1 记录
  const deletedChunks = await abortPendingChunkUpload(
    session.upload_id,
    session.chat_id,
    config
  );

  const cancelledSession = await config.database.prepare(
    'SELECT * FROM bot_upload_sessions WHERE id = ? LIMIT 1'
  ).bind(session.id).first();

  // 页面即使已经关闭，也通过机器人明确告知任务已被取消
  try {
    await sendMessage(
      session.chat_id,
      `⏱️ <b>大文件上传任务已取消</b>

` +
      `原因：两个分片间隔超过 ${LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES} 分钟
` +
      `已清理分片：${deletedChunks} 个

` +
      '请重新点击“上传大文件”创建新任务',
      config.tgBotToken
    );
  } catch (notifyError) {
    console.warn('发送大文件超时取消通知失败:', notifyError.message);
  }

  return {
    session: cancelledSession || { ...session, status: LARGE_UPLOAD_SESSION_STATUS.CANCELLED, error_message: reason },
    cancelled: true,
    deletedChunks
  };
}

async function enforceLargeUploadChunkTimeout(session, config) {
  const result = await cancelLargeUploadSessionForChunkTimeout(session, config);
  return result.session || session;
}

// 供 Cloudflare Cron Trigger 使用网页关闭后仍能自动清理超过 10 分钟
// 没有继续上传下一片的任务
async function cleanupStaleLargeUploadSessions(config, limit = 100) {
  const cutoff = Date.now() - LARGE_UPLOAD_CHUNK_TIMEOUT_MS;
  const result = await config.database.prepare(`
    SELECT s.*
    FROM bot_upload_sessions s
    WHERE s.status = ?
      AND s.total_chunks > 0
      AND (
        SELECT COUNT(*)
        FROM file_chunks c
        WHERE c.upload_id = s.upload_id
          AND c.chat_id = s.chat_id
          AND c.file_id IS NULL
      ) > 0
      AND (
        SELECT COUNT(*)
        FROM file_chunks c
        WHERE c.upload_id = s.upload_id
          AND c.chat_id = s.chat_id
          AND c.file_id IS NULL
      ) < s.total_chunks
      AND (
        SELECT MAX(c.created_at)
        FROM file_chunks c
        WHERE c.upload_id = s.upload_id
          AND c.chat_id = s.chat_id
          AND c.file_id IS NULL
      ) < ?
    ORDER BY s.id ASC
    LIMIT ?
  `).bind(
    LARGE_UPLOAD_SESSION_STATUS.UPLOADING,
    cutoff,
    Math.max(1, Number(limit || 100))
  ).all();

  let cancelled = 0;
  let deletedChunks = 0;
  for (const session of result.results || []) {
    const cleanup = await cancelLargeUploadSessionForChunkTimeout(session, config);
    if (cleanup.cancelled) {
      cancelled += 1;
      deletedChunks += Number(cleanup.deletedChunks || 0);
    }
  }
  return { cancelled, deletedChunks };
}

async function buildLargeUploadStatusPayload(session, config) {
  const progress = await getLargeUploadProgress(session, config);
  const fileSize = Number(session.file_size || 0);
  const percent = fileSize > 0
    ? Math.min(100, Math.round(progress.uploadedBytes / fileSize * 10000) / 100)
    : 0;
  const cancelled = isLargeUploadSessionCancelled(session);
  const chunkDeadlineAt =
    progress.lastChunkAt > 0 &&
    progress.uploadedChunks > 0 &&
    progress.uploadedChunks < Number(session.total_chunks || 0)
      ? progress.lastChunkAt + LARGE_UPLOAD_CHUNK_TIMEOUT_MS
      : 0;

  return {
    status: String(session.status || LARGE_UPLOAD_SESSION_STATUS.PENDING),
    expired: isLargeUploadSessionExpired(session),
    cancelled,
    closePage: cancelled,
    canStart:
      !cancelled &&
      (!isLargeUploadSessionExpired(session) || mayContinueLargeUploadSession(session)),
    expiresAt: Number(session.expires_at || 0),
    fileName: session.file_name || '',
    fileSize,
    mimeType: session.mime_type || '',
    totalChunks: Number(session.total_chunks || 0),
    uploadedChunks: progress.uploadedChunks,
    uploadedBytes: progress.uploadedBytes,
    uploadedIndexes: progress.uploadedIndexes,
    lastChunkAt: progress.lastChunkAt,
    chunkDeadlineAt,
    chunkTimeoutMinutes: LARGE_UPLOAD_CHUNK_TIMEOUT_MINUTES,
    progress: percent,
    resultUrl: session.result_url || '',
    error: session.error_message || ''
  };
}

async function handleLargeUploadPageRequest(request, config) {
  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const token = getLargeUploadTokenFromRequest(request);
  let session = await getLargeUploadSessionByToken(token, config);
  if (!session) {
    return new Response(generateLargeUploadMessagePage(
      '上传页面无效',
      '该上传链接不存在或已被新的链接替换，请返回机器人重新点击“上传大文件”'
    ), {
      status: 404,
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
    });
  }

  session = await enforceLargeUploadChunkTimeout(session, config);

  // UPDATE_TIME 只限制仍未开始的入口cancelled 会继续返回完整页面，
  // 由前端显示取消原因并主动关闭，而不是被误判成普通过期页
  if (
    String(session.status || '') === LARGE_UPLOAD_SESSION_STATUS.PENDING &&
    isLargeUploadSessionExpired(session)
  ) {
    return new Response(generateLargeUploadMessagePage(
      '上传页面已过期',
      `该页面在创建后 ${Number(config.updateTimeMinutes || 20)} 分钟内未开始上传，请返回机器人重新生成`
    ), {
      status: 410,
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
    });
  }

  const categories = await config.database.prepare(`
    SELECT id, name
    FROM categories
    ORDER BY CASE WHEN name = '默认分类' THEN 0 ELSE 1 END, id ASC
  `).all();
  const categoryOptions = (categories.results || []).map(category => {
    const selected = Number(category.id) === Number(session.category_id) ? ' selected' : '';
    return `<option value="${Number(category.id)}"${selected}>${escapeHtml(category.name)}</option>`;
  }).join('');
  const statusPayload = await buildLargeUploadStatusPayload(session, config);

  return new Response(generateLargeUploadPage({
    token,
    categoryOptions,
    statusPayload,
    chunkSizeBytes: getTelegramChunkSizeBytes(config),
    maxSizeBytes: Number(config.maxSizeMB || 1024) * 1024 * 1024,
    updateTimeMinutes: Number(config.updateTimeMinutes || 20)
  }), {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}

async function handleLargeUploadStatusRequest(request, config) {
  if (request.method !== 'GET') {
    return largeUploadJson({ status: 0, error: '只支持 GET' }, 405);
  }
  const token = getLargeUploadTokenFromRequest(request);
  let session = await getLargeUploadSessionByToken(token, config);
  if (!session) return largeUploadJson({ status: 0, error: '上传会话不存在' }, 404);
  session = await enforceLargeUploadChunkTimeout(session, config);
  return largeUploadJson({
    status: 1,
    session: await buildLargeUploadStatusPayload(session, config)
  });
}

async function resolveLargeUploadCategory(categoryValue, session, config) {
  let categoryId = Number(categoryValue || session.category_id || 0);
  if (Number.isInteger(categoryId) && categoryId > 0) {
    const category = await config.database.prepare(
      'SELECT id FROM categories WHERE id = ? LIMIT 1'
    ).bind(categoryId).first();
    if (category) return Number(category.id);
  }
  const defaultCategory = await config.database.prepare(
    'SELECT id FROM categories WHERE name = ? LIMIT 1'
  ).bind('默认分类').first();
  return defaultCategory ? Number(defaultCategory.id) : null;
}

async function handleLargeUploadChunkRequest(request, config) {
  if (request.method !== 'POST') {
    return largeUploadJson({ status: 0, error: '只支持 POST' }, 405);
  }

  try {
    const formData = await request.formData();
    const token = getLargeUploadTokenFromRequest(request, formData);
    let session = await getLargeUploadSessionByToken(token, config);
    if (!session) throw new Error('上传会话不存在');
    session = await enforceLargeUploadChunkTimeout(session, config);
    if (isLargeUploadSessionCancelled(session)) {
      return largeUploadJson({
        status: 0,
        cancelled: true,
        closePage: true,
        error: session.error_message || '上传任务已取消'
      }, 410);
    }
    if (session.status === LARGE_UPLOAD_SESSION_STATUS.COMPLETED) {
      return largeUploadJson({ status: 1, completed: true, url: session.result_url });
    }
    if (isLargeUploadSessionExpired(session) && !mayContinueLargeUploadSession(session)) {
      throw new Error('上传页面已过期，请返回机器人重新生成');
    }

    const chunk = formData.get('chunk');
    const chunkIndex = Number(formData.get('chunk_index'));
    const totalChunks = Number(formData.get('total_chunks'));
    const fileName = sanitizeTelegramFileName(formData.get('file_name'), 'large-file.bin');
    const fileSize = Number(formData.get('file_size') || 0);
    const mimeType = String(formData.get('mime_type') || 'application/octet-stream');
    const categoryId = await resolveLargeUploadCategory(formData.get('category'), session, config);
    const maxChunkSize = getTelegramChunkSizeBytes(config);

    if (!chunk || typeof chunk.slice !== 'function') throw new Error('缺少分片数据');
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('chunk_index 无效');
    if (!Number.isInteger(totalChunks) || totalChunks < 1 || chunkIndex >= totalChunks) {
      throw new Error('total_chunks 无效');
    }
    if (fileSize <= 0 || fileSize > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过${config.maxSizeMB}MB限制或大小无效`);
    }
    if (totalChunks !== Math.ceil(fileSize / maxChunkSize)) {
      throw new Error('total_chunks 与文件大小不匹配');
    }
    const expectedChunkSize = chunkIndex < totalChunks - 1
      ? maxChunkSize
      : fileSize - maxChunkSize * (totalChunks - 1);
    if (Number(chunk.size) !== expectedChunkSize) {
      throw new Error(`第 ${chunkIndex + 1} 片大小不正确`);
    }

    if (session.status === LARGE_UPLOAD_SESSION_STATUS.PENDING) {
      await config.database.prepare(`
        UPDATE bot_upload_sessions
        SET status = ?, category_id = ?, file_name = ?, file_size = ?,
            mime_type = ?, total_chunks = ?, started_at = ?, error_message = NULL
        WHERE id = ? AND status = ?
      `).bind(
        LARGE_UPLOAD_SESSION_STATUS.UPLOADING,
        categoryId,
        fileName,
        fileSize,
        mimeType,
        totalChunks,
        Date.now(),
        session.id,
        LARGE_UPLOAD_SESSION_STATUS.PENDING
      ).run();
      session = await config.database.prepare(
        'SELECT * FROM bot_upload_sessions WHERE id = ? LIMIT 1'
      ).bind(session.id).first();
    } else {
      if (String(session.file_name || '') !== fileName || Number(session.file_size) !== fileSize) {
        throw new Error('所选文件与当前上传会话中的文件不一致');
      }
      if (Number(session.total_chunks) !== totalChunks) {
        throw new Error('分片数量与当前上传会话不一致');
      }
    }

    await uploadOneTelegramChunk(
      chunk,
      session.upload_id,
      chunkIndex,
      totalChunks,
      fileName,
      session.chat_id,
      config
    );

    // 上传 Telegram 分片期间，状态轮询或 Cron 可能刚好触发超时取消
    // 再次检查并清理刚刚完成的孤立分片，确保取消后不会残留
    session = await config.database.prepare(
      'SELECT * FROM bot_upload_sessions WHERE id = ? LIMIT 1'
    ).bind(session.id).first();
    if (isLargeUploadSessionCancelled(session)) {
      await abortPendingChunkUpload(session.upload_id, session.chat_id, config);
      return largeUploadJson({
        status: 0,
        cancelled: true,
        closePage: true,
        error: session.error_message || '上传任务已取消'
      }, 410);
    }

    const progress = await getLargeUploadProgress(session, config);
    await config.database.prepare(`
      UPDATE bot_upload_sessions
      SET uploaded_chunks = ?, uploaded_bytes = ?, error_message = NULL
      WHERE id = ?
    `).bind(progress.uploadedChunks, progress.uploadedBytes, session.id).run();

    return largeUploadJson({
      status: 1,
      chunkIndex,
      uploadedChunks: progress.uploadedChunks,
      uploadedBytes: progress.uploadedBytes,
      totalChunks,
      progress: Math.min(100, Math.round(progress.uploadedBytes / fileSize * 10000) / 100)
    });
  } catch (error) {
    console.error('[Large Upload Chunk Error]', error);
    return largeUploadJson({ status: 0, error: error.message }, 400);
  }
}

async function handleLargeUploadCompleteRequest(request, config) {
  if (request.method !== 'POST') {
    return largeUploadJson({ status: 0, error: '只支持 POST' }, 405);
  }

  let session = null;
  try {
    const body = await request.json();
    const token = getLargeUploadTokenFromRequest(request, body);
    session = await getLargeUploadSessionByToken(token, config);
    if (!session) throw new Error('上传会话不存在');
    session = await enforceLargeUploadChunkTimeout(session, config);
    if (isLargeUploadSessionCancelled(session)) {
      return largeUploadJson({
        status: 0,
        cancelled: true,
        closePage: true,
        error: session.error_message || '上传任务已取消'
      }, 410);
    }
    if (session.status === LARGE_UPLOAD_SESSION_STATUS.COMPLETED) {
      return largeUploadJson({ status: 1, completed: true, url: session.result_url });
    }
    if (![LARGE_UPLOAD_SESSION_STATUS.UPLOADING, LARGE_UPLOAD_SESSION_STATUS.FINALIZING].includes(session.status)) {
      throw new Error('上传尚未开始或当前状态不可完成');
    }

    await config.database.prepare(`
      UPDATE bot_upload_sessions
      SET status = ?, error_message = NULL
      WHERE id = ?
    `).bind(LARGE_UPLOAD_SESSION_STATUS.FINALIZING, session.id).run();

    const file = await finalizeChunkedTelegramUpload({
      uploadId: session.upload_id,
      chatId: session.chat_id,
      fileName: session.file_name,
      fileSize: Number(session.file_size),
      mimeType: session.mime_type || 'application/octet-stream',
      categoryId: session.category_id || null,
      key: generateSafeKey(session.file_name),
      totalChunks: Number(session.total_chunks)
    }, config);

    const completedAt = Date.now();
    await config.database.prepare(`
      UPDATE bot_upload_sessions
      SET status = ?, result_file_id = ?, result_url = ?,
          uploaded_chunks = total_chunks, uploaded_bytes = file_size,
          completed_at = ?, error_message = NULL
      WHERE id = ?
    `).bind(
      LARGE_UPLOAD_SESSION_STATUS.COMPLETED,
      file.id,
      file.url,
      completedAt,
      session.id
    ).run();

    // 即使用户已经关闭临时网页，也会在机器人会话中收到永久直链和二维码
    try {
      await sendUploadCompletedWithQr({
        chatId: session.chat_id,
        title: '大文件上传完成',
        fileName: session.file_name,
        fileSize: Number(session.file_size || 0),
        url: file.url,
        chunkCount: Number(session.total_chunks || 0)
      }, config);
    } catch (notifyError) {
      console.warn('发送大文件合并完成消息失败:', notifyError.message);
      await sendMessage(
        session.chat_id,
        buildUploadCompletedCaption({
          title: '大文件上传完成',
          fileName: session.file_name,
          fileSize: Number(session.file_size || 0),
          url: file.url,
          chunkCount: Number(session.total_chunks || 0),

          includeQrHint: false
        }),
        config.tgBotToken
      );


    }

    return largeUploadJson({
      status: 1,
      completed: true,
      url: file.url,
      fileName: session.file_name,
      fileSize: Number(session.file_size || 0),
      chunkCount: Number(session.total_chunks || 0)
    });
  } catch (error) {
    console.error('[Large Upload Complete Error]', error);
    if (session && session.id) {
      await config.database.prepare(`
        UPDATE bot_upload_sessions
        SET status = ?, error_message = ?
        WHERE id = ?
      `).bind(
        LARGE_UPLOAD_SESSION_STATUS.UPLOADING,
        String(error.message || '完成上传失败').slice(0, 500),
        session.id
      ).run().catch(() => null);
    }
    return largeUploadJson({ status: 0, error: error.message }, 400);
  }
}

async function handleUploadRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }

  const chatId = getWebOwnerChatId(config);
  if (!chatId) {
    return new Response('未配置 TG_ADMIN_ID，网页上传无法确定文件归属用户', {
      status: 500,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', 'Cache-Control': 'no-store' }
    });
  }

  if (request.method === 'GET') {
    const categories = await config.database.prepare('SELECT id, name FROM categories').all();
    const categoryOptions = categories.results.length
      ? categories.results.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')
      : '<option value="">暂无分类</option>';
    let userSetting = await config.database.prepare(
      'SELECT * FROM user_settings WHERE chat_id = ?'
    ).bind(chatId).first();
    if (!userSetting) {
      const defaultCategory = await config.database.prepare(
        'SELECT id FROM categories WHERE name = ?'
      ).bind('默认分类').first();
      await config.database.prepare(`
        INSERT INTO user_settings (chat_id, storage_type, current_category_id)
        VALUES (?, ?, ?)
      `).bind(chatId, 'telegram', defaultCategory && defaultCategory.id).run();
      userSetting = {
        storage_type: 'telegram',
        current_category_id: defaultCategory && defaultCategory.id
      };
    }
    return new Response(generateUploadPage(categoryOptions, userSetting.storage_type), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const categoryId = formData.get('category');
    const storageType = formData.get('storage_type') === 'r2' ? 'r2' : 'telegram';
    if (!file || typeof file.slice !== 'function') throw new Error('未找到文件');
    if (Number(file.size) > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过${config.maxSizeMB}MB限制`);
    }

    let defaultCategory = await config.database.prepare(
      'SELECT id FROM categories WHERE name = ?'
    ).bind('默认分类').first();
    if (!defaultCategory) {
      const result = await config.database.prepare(
        'INSERT INTO categories (name, created_at) VALUES (?, ?)'
      ).bind('默认分类', Date.now()).run();
      defaultCategory = { id: result.meta && result.meta.last_row_id };
    }
    const finalCategoryId = categoryId || (defaultCategory && defaultCategory.id) || null;
    await config.database.prepare(`
      UPDATE user_settings
      SET storage_type = ?, current_category_id = ?
      WHERE chat_id = ?
    `).bind(storageType, finalCategoryId, chatId).run();

    const rawExt = (file.name.split('.').pop() || '').toLowerCase();
    const mimeType = file.type || getContentType(rawExt);
    const key = generateSafeKey(file.name);
    let finalUrl;
    let chunked = false;
    let chunkCount = 0;

    if (storageType === 'r2') {
      if (!config.bucket) throw new Error('未配置R2存储桶(BUCKET)，无法使用R2存储');
      await config.bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: mimeType }
      });
      finalUrl = `https://${config.domain}/${key}`;
      await insertFileRecord({
        url: finalUrl,
        fileId: key,
        messageId: -1,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        storageType: 'r2',
        categoryId: finalCategoryId,
        chatId,
        isChunked: false
      }, config);
    } else {
      const saved = await saveTelegramFileFromBlob({
        blob: file,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        categoryId: finalCategoryId,
        chatId,
        key
      }, config);
      finalUrl = saved.url;
      chunked = saved.isChunked;
      chunkCount = saved.chunkCount;
    }

    return new Response(JSON.stringify({
      status: 1,
      msg: chunked ? `✔ 分片上传成功（${chunkCount}片）` : '✔ 上传成功',
      url: finalUrl,
      chunked,
      chunk_count: chunkCount
    }), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  } catch (error) {
    console.error(`[Upload Error] ${error.message}`);
    let statusCode = 500;
    if (error.message.includes('文件超过')) statusCode = 400;
    else if (error.message.includes('Telegram')) statusCode = 502;
    else if (error instanceof TypeError && error.message.includes('Failed to fetch')) statusCode = 504;
    return new Response(JSON.stringify({
      status: 0,
      msg: '✘ 上传失败',
      error: error.message
    }), {
      status: statusCode,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}

async function handleUploadChunkRequest(request, config) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ status: 0, error: '只支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
  const chatId = getWebOwnerChatId(config);
  if (!chatId) throw new Error('未配置 TG_ADMIN_ID');

  try {
    const formData = await request.formData();
    const uploadId = normalizeUploadId(formData.get('upload_id'));
    const chunk = formData.get('chunk');
    const chunkIndex = Number(formData.get('chunk_index'));
    const totalChunks = Number(formData.get('total_chunks'));
    const fileName = String(formData.get('file_name') || 'large-file.bin');
    const fileSize = Number(formData.get('file_size') || 0);

    if (!uploadId) throw new Error('upload_id 格式无效');
    if (!chunk || typeof chunk.slice !== 'function') throw new Error('缺少分片数据');
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new Error('chunk_index 无效');
    if (!Number.isInteger(totalChunks) || totalChunks <= 1 || chunkIndex >= totalChunks) {
      throw new Error('total_chunks 无效');
    }
    if (fileSize <= 0 || fileSize > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过${config.maxSizeMB}MB限制或大小无效`);
    }
    const maxChunkSize = getTelegramChunkSizeBytes(config);
    if (Number(chunk.size) <= 0 || Number(chunk.size) > maxChunkSize) {
      throw new Error(`单个分片必须大于0且不超过${config.telegramChunkSizeMB}MB`);
    }
    if (totalChunks !== Math.ceil(fileSize / maxChunkSize)) {
      throw new Error('total_chunks 与文件大小不匹配');
    }

    const saved = await uploadOneTelegramChunk(
      chunk,
      uploadId,
      chunkIndex,
      totalChunks,
      fileName,
      chatId,
      config
    );

    return new Response(JSON.stringify({
      status: 1,
      chunk_index: chunkIndex,
      chunk_size: Number(saved.chunk_size || chunk.size)
    }), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  } catch (error) {
    console.error('[Chunk Upload Error]', error);
    return new Response(JSON.stringify({ status: 0, error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}

async function handleUploadCompleteRequest(request, config) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ status: 0, error: '只支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
  const chatId = getWebOwnerChatId(config);
  try {
    if (!chatId) throw new Error('未配置 TG_ADMIN_ID');
    const body = await request.json();
    const uploadId = normalizeUploadId(body.upload_id);
    const fileName = sanitizeTelegramFileName(body.file_name, 'large-file.bin');
    const fileSize = Number(body.file_size || 0);
    const mimeType = String(body.mime_type || 'application/octet-stream');
    const totalChunks = Number(body.total_chunks || 0);
    let categoryId = body.category || null;
    const key = body.key ? String(body.key) : generateSafeKey(fileName);

    if (!uploadId) throw new Error('upload_id 格式无效');
    if (!Number.isInteger(totalChunks) || totalChunks <= 1) throw new Error('total_chunks 无效');
    if (fileSize <= 0 || fileSize > Number(config.maxSizeMB) * 1024 * 1024) {
      throw new Error(`文件超过${config.maxSizeMB}MB限制或大小无效`);
    }
    const expectedChunks = Math.ceil(fileSize / getTelegramChunkSizeBytes(config));
    if (totalChunks !== expectedChunks) {
      throw new Error(`total_chunks 不匹配：应为 ${expectedChunks}`);
    }
    if (!categoryId) {
      const defaultCategory = await config.database.prepare(
        'SELECT id FROM categories WHERE name = ? LIMIT 1'
      ).bind('默认分类').first();
      categoryId = defaultCategory && defaultCategory.id;
    }

    await config.database.prepare(`
      UPDATE user_settings
      SET storage_type = 'telegram', current_category_id = ?
      WHERE chat_id = ?
    `).bind(categoryId || null, chatId).run();

    const file = await finalizeChunkedTelegramUpload({
      uploadId,
      chatId,
      fileName,
      fileSize,
      mimeType,
      categoryId,
      key,
      totalChunks
    }, config);

    return new Response(JSON.stringify({
      status: 1,
      msg: `✔ 分片上传成功（${totalChunks}片）`,
      url: file.url,
      chunked: true,
      chunk_count: totalChunks
    }), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  } catch (error) {
    console.error('[Chunk Complete Error]', error);
    return new Response(JSON.stringify({ status: 0, error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}

async function handleUploadAbortRequest(request, config) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ status: 0, error: '只支持 POST' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
  const chatId = getWebOwnerChatId(config);
  try {
    if (!chatId) throw new Error('未配置 TG_ADMIN_ID');
    const body = await request.json();
    const deleted = await abortPendingChunkUpload(body.upload_id, chatId, config);
    return new Response(JSON.stringify({ status: 1, deleted }), {
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 0, error: error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
  }
}
async function handleDeleteMultipleRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { urls } = await request.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ status: 0, error: '无效的URL列表' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const results = { success: [], failed: [] };
    for (const url of urls) {
      try {
        const fileName = String(url).split('/').pop();
        let file = await config.database.prepare(
          'SELECT * FROM files WHERE url = ?'
        ).bind(url).first();
        if (!file && fileName) {
          file = await config.database.prepare(
            'SELECT * FROM files WHERE fileId = ? OR url LIKE ? ORDER BY id DESC LIMIT 1'
          ).bind(fileName, `%/${fileName}`).first();
        }
        if (!file) {
          results.failed.push({ url, reason: '未找到文件记录' });
          continue;
        }
        const deleted = await deleteStoredFileRecord(file, config);
        results.success.push({
          url,
          deletedChunks: deleted.deletedChunkRows,
          cleanupWarnings: deleted.failedTelegramMessages
        });
      } catch (error) {
        results.failed.push({ url, reason: error.message });
      }
    }

    return new Response(JSON.stringify({
      status: 1,
      message: '批量删除处理完成',
      results: {
        success: results.success.length,
        failed: results.failed.length,
        details: results
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ status: 0, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
function createApiJsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-store'
      }
    }
  );
}

// 用户管理页面
async function handleUserManagementRequest(request, config) {
  if (request.method !== 'GET') {
    return new Response(
      'Method Not Allowed',
      {
        status: 405,
        headers: {
          'Cache-Control': 'no-store'
        }
      }
    );
  }

  return new Response(
    generateUserManagementPage(),
    {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'no-store'
      }
    }
  );
}

// 获取管理员和普通授权用户
async function handleListAllowedUsersRequest(request, config) {
  if (request.method !== 'GET') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const users = await listAllowedTelegramUsers(config);

    return createApiJsonResponse({
      status: 1,
      admins: config.tgAdminId || [],
      users
    });
  } catch (error) {
    console.error('获取授权用户列表失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      500
    );
  }
}

// 网页添加授权用户
async function handleAddAllowedUserRequest(request, config) {
  if (request.method !== 'POST') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const body = await request.json();
    const chatId = normalizeTelegramUserId(
      body && body.chat_id
    );

    if (!chatId) {
      return createApiJsonResponse(
        {
          status: 0,
          error: '请输入正确的纯数字 Telegram 用户 ID'
        },
        400
      );
    }

    const result = await addAllowedTelegramUser(
      chatId,
      `web:${config.username || 'admin'}`,
      config
    );

    let message = '';

    if (result.alreadyAdmin) {
      message = '该用户已经是 TG_ADMIN_ID 管理员';
    } else if (result.created) {
      message = '用户添加成功';
    } else {
      message = '该用户已经在授权列表中';
    }

    return createApiJsonResponse({
      status: 1,
      created: result.created,
      already_admin: result.alreadyAdmin,
      chat_id: chatId,
      message
    });
  } catch (error) {
    console.error('网页添加授权用户失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      500
    );
  }
}

// 网页删除授权用户
async function handleDeleteAllowedUserRequest(request, config) {
  if (request.method !== 'POST') {
    return createApiJsonResponse(
      {
        status: 0,
        error: 'Method Not Allowed'
      },
      405
    );
  }

  try {
    const body = await request.json();
    const chatId = normalizeTelegramUserId(
      body && body.chat_id
    );

    if (!chatId) {
      return createApiJsonResponse(
        {
          status: 0,
          error: '用户 ID 格式不正确'
        },
        400
      );
    }

    const removed = await removeAllowedTelegramUser(
      chatId,
      config
    );

    return createApiJsonResponse({
      status: 1,
      removed,
      chat_id: chatId,
      message: removed
        ? '用户权限已删除'
        : '该用户已不在授权列表中'
    });
  } catch (error) {
    console.error('网页删除授权用户失败:', error);

    return createApiJsonResponse(
      {
        status: 0,
        error: error.message
      },
      400
    );
  }
}
async function handleAdminRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const categories = await config.database.prepare('SELECT id, name FROM categories').all();
    const categoryOptions = categories.results.length
      ? categories.results.map(c => `<option value="${c.id}">${c.name}</option>`).join('')
      : '<option value="">暂无分类</option>';
    const files = await config.database.prepare(`
      SELECT f.id, f.url, f.fileId, f.message_id, f.created_at, f.file_name,
             f.file_size, f.mime_type, f.storage_type, f.is_chunked,
             f.chunk_count, f.upload_id,
             c.name as category_name, c.id as category_id
      FROM files f
      LEFT JOIN categories c ON f.category_id = c.id
      ORDER BY f.created_at DESC
    `).all();
    const fileList = files.results || [];
    console.log(`文件总数: ${fileList.length}`);
    const fileCards = fileList.map(file => {
        const url = file.url;
        const uniqueId = `file-checkbox-${encodeURIComponent(url)}`;
        return `
          <div class="file-card" data-file-id="${file.id}" data-url="${url}" data-category-id="${file.category_id || ''}" data-chunked="${Number(file.is_chunked || 0)}">
            <input type="checkbox" id="${uniqueId}" name="selectedFile" class="file-checkbox" value="${url}">
            <div class="file-preview">
              ${getPreviewHtml(url)}
            </div>
            <div class="file-info">
              <div>${getStoredDisplayName(file)}</div>
              <div>大小: ${formatSize(file.file_size || 0)}</div>
              <div>存储: ${file.storage_type === 'r2' ? 'R2' : (Number(file.is_chunked || 0) === 1 ? `Telegram 分片（${Number(file.chunk_count || 0)}片）` : 'Telegram')}</div>
              <div>上传时间: ${formatDate(file.created_at)}</div>
              <div>分类: ${file.category_name || '无分类'}</div>
            </div>
            <div class="file-actions" style="display:flex; gap:5px; justify-content:space-between; padding:10px;">
              <button class="btn btn-share" style="flex:1; background-color:#3498db; color:white; padding:8px 12px; border-radius:6px; border:none; cursor:pointer; font-weight:bold;" onclick="shareFile('${url}', '${getStoredDisplayName(file)}')">分享</button>
              <button class="btn btn-delete" style="flex:1;" onclick="showConfirmModal('确定要删除这个文件吗？', function() { deleteFile('${url}'); })">删除</button>
              <button class="btn btn-edit" style="flex:1;" onclick="showEditSuffixModal('${url}')">修改后缀</button>
            </div>
          </div>
        `;
    }).join('');
    const html = generateAdminPage(fileCards, categoryOptions);
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  } catch (error) {
    console.error(`[Admin Error] ${error.message}`);
    return new Response(`加载文件列表失败，请检查数据库配置：${error.message}`, { status: 500 });
  }
}
async function handleSearchRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { query } = await request.json();
    const searchPattern = `%${query}%`;
    const files = await config.database.prepare(`
      SELECT id, url, fileId, message_id, created_at, file_name, file_size,
             mime_type, storage_type, is_chunked, chunk_count, upload_id
       FROM files 
       WHERE file_name LIKE ? ESCAPE '!'
       COLLATE NOCASE
       ORDER BY created_at DESC
    `).bind(searchPattern).all();
    return new Response(
      JSON.stringify({ files: files.results || [] }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error(`[Search Error] ${error.message}`);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
function getPreviewHtml(url) {
  const ext = (url.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'icon'].includes(ext);
  const isVideo = ['mp4', 'webm'].includes(ext);
  const isAudio = ['mp3', 'wav', 'ogg'].includes(ext);
  if (isImage) {
    return `<img src="${url}" alt="预览">`;
  } else if (isVideo) {
    return `<video src="${url}" controls></video>`;
  } else if (isAudio) {
    return `<audio src="${url}" controls></audio>`;
  } else {
    return `<div style="font-size: 48px">📄</div>`;
  }
}
async function handleFileRequest(request, config) {
  try {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(1));
    if (!path) return new Response('Not Found', { status: 404 });

    const rangeHeader = request.headers.get('Range');
    const cacheKey = `file:${path}`;
    if (!rangeHeader && request.method !== 'HEAD' && config.fileCache && config.fileCache.has(cacheKey)) {
      const cachedData = config.fileCache.get(cacheKey);
      if (Date.now() - cachedData.timestamp < config.fileCacheTTL) {
        return cachedData.response.clone();
      }
      config.fileCache.delete(cacheKey);
    }

    const cacheAndReturnResponse = (response, allowCache = true) => {
      if (allowCache && !rangeHeader && request.method !== 'HEAD' && config.fileCache) {
        config.fileCache.set(cacheKey, { response: response.clone(), timestamp: Date.now() });
      }
      return response;
    };

    // R2 原始 key 优先
    if (config.bucket) {
      try {
        const object = await config.bucket.get(path);
        if (object) {
          const contentType = object.httpMetadata.contentType || getContentType(path.split('.').pop());
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          headers.set('Content-Type', contentType);
          headers.set('Access-Control-Allow-Origin', '*');
          headers.set('Cache-Control', 'public, max-age=31536000');
          headers.set('etag', object.httpEtag);
          return cacheAndReturnResponse(new Response(
            request.method === 'HEAD' ? null : object.body,
            { headers }
          ));
        }
      } catch (error) {
        if (error.name !== 'NoSuchKey') console.error('R2获取文件错误:', error);
      }
    }

    const urlPattern = `https://${config.domain}/${path}`;
    let file = await config.database.prepare(
      'SELECT * FROM files WHERE url = ?'
    ).bind(urlPattern).first();
    if (!file) {
      file = await config.database.prepare(
        'SELECT * FROM files WHERE fileId = ?'
      ).bind(path).first();
    }
    if (!file) {
      const fileName = path.split('/').pop();
      file = await config.database.prepare(
        'SELECT * FROM files WHERE file_name = ? ORDER BY id DESC LIMIT 1'
      ).bind(fileName).first();
    }
    if (!file) return new Response('文件不存在', { status: 404 });

    const contentType = file.mime_type || getContentType(path.split('.').pop());
    const totalSize = Number(file.file_size || 0);
    const fileName = file.file_name || path.split('/').pop() || 'download.bin';
    const inline = contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/');
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=31536000');
    headers.set(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeContentDispositionFileName(fileName)}`
    );

    const parsedRange = totalSize > 0 ? parseByteRange(rangeHeader, totalSize) : null;
    if (parsedRange && parsedRange.invalid) {
      headers.set('Content-Range', `bytes */${totalSize}`);
      return new Response('Requested Range Not Satisfiable', { status: 416, headers });
    }
    const rangeStart = parsedRange ? parsedRange.start : 0;
    const rangeEnd = parsedRange ? parsedRange.end : Math.max(0, totalSize - 1);
    if (totalSize > 0) {
      headers.set('Content-Length', String(rangeEnd - rangeStart + 1));
      if (parsedRange) headers.set('Content-Range', `bytes ${rangeStart}-${rangeEnd}/${totalSize}`);
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: parsedRange ? 206 : 200, headers });
    }

    if (file.storage_type === 'telegram') {
      if (Number(file.is_chunked || 0) === 1) {
        const chunks = await loadChunkRows(file, config);
        if (!chunks.length) throw new Error('没有找到任何分片');
        const selections = buildChunkSelections(chunks, rangeStart, rangeEnd);
        if (!selections.length) throw new Error('请求范围没有对应分片');
        const stream = createTelegramChunkStream(selections, config);
        return new Response(stream, {
          status: parsedRange ? 206 : 200,
          headers
        });
      }

      if (!file.fileId) throw new Error('文件记录缺少 Telegram fileId');
      const response = await getTelegramFileResponse(
        file.fileId,
        config,
        parsedRange ? rangeStart : null,
        parsedRange ? rangeEnd : null
      );
      let body = response.body;
      if (parsedRange && response.status !== 206) {
        const buffer = await response.arrayBuffer();
        body = buffer.slice(rangeStart, rangeEnd + 1);
      }
      const output = new Response(body, {
        status: parsedRange ? 206 : 200,
        headers
      });
      return cacheAndReturnResponse(output, totalSize > 0 && totalSize <= 5 * 1024 * 1024);
    }

    if (file.storage_type === 'r2' && config.bucket) {
      const object = await config.bucket.get(file.fileId);
      if (object) {
        object.writeHttpMetadata(headers);
        return cacheAndReturnResponse(new Response(object.body, { headers }));
      }
    }

    if (file.url && file.url !== urlPattern) return Response.redirect(file.url, 302);
    return new Response('File not available', { status: 404 });
  } catch (error) {
    console.error('处理文件请求出错:', error);
    return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
  }
}
async function handleDeleteRequest(request, config) {
  if (config.enableAuth && !authenticate(request, config)) {
    return Response.redirect(`${new URL(request.url).origin}/`, 302);
  }
  try {
    const { id, fileId } = await request.json();
    if (!id && !fileId) {
      return new Response(JSON.stringify({ status: 0, message: '缺少文件标识信息' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let file = null;
    if (id && String(id).startsWith('http')) {
      file = await config.database.prepare('SELECT * FROM files WHERE url = ?').bind(id).first();
    } else if (id) {
      file = await config.database.prepare('SELECT * FROM files WHERE id = ?').bind(id).first();
    }
    if (!file && fileId) {
      file = await config.database.prepare('SELECT * FROM files WHERE fileId = ?').bind(fileId).first();
    }
    if (!file) {
      return new Response(JSON.stringify({ status: 0, message: '文件不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const deleted = await deleteStoredFileRecord(file, config);
    return new Response(JSON.stringify({
      status: 1,
      message: deleted.failedTelegramMessages.length
        ? '文件已删除，但部分 Telegram 存储消息未能立即清理'
        : '删除成功',
      deletedChunks: deleted.deletedChunkRows,
      deletedStorageMessages: deleted.deletedStorageMessages,
      cleanupWarnings: deleted.failedTelegramMessages
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('删除文件失败:', error);
    return new Response(JSON.stringify({
      status: 0,
      message: '删除文件失败: ' + error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
function getContentType(ext) {
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    ico: 'image/x-icon',
    icon: 'image/x-icon',
    bmp: 'image/bmp',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogv: 'video/ogg',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
    ts: 'video/mp2t',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wma: 'audio/x-ms-wma',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    xml: 'application/xml',
    json: 'application/json',
    zip: 'application/zip',
    rar: 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    swf: 'application/x-shockwave-flash',
    ttf: 'font/ttf',
    otf: 'font/otf',
    woff: 'font/woff',
    woff2: 'font/woff2',
    eot: 'application/vnd.ms-fontobject',
    ini: 'text/plain',
    yml: 'application/yaml',
    yaml: 'application/yaml',
    toml: 'text/plain',
    py: 'text/x-python',
    java: 'text/x-java',
    c: 'text/x-c',
    cpp: 'text/x-c++',
    cs: 'text/x-csharp',
    php: 'application/x-php',
    rb: 'text/x-ruby',
    go: 'text/x-go',
    rs: 'text/x-rust',
    sh: 'application/x-sh',
    bat: 'application/x-bat',
    sql: 'application/sql'
  };
  const lowerExt = ext.toLowerCase();
  return types[lowerExt] || 'application/octet-stream';
}
async function handleBingImagesRequest(request, config) {
  const cache = caches.default;
  const cacheKey = new Request('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    console.log('Returning cached response');
    return cachedResponse;
  }
  try {
    const res = await fetch(cacheKey);
    if (!res.ok) {
      console.error(`Bing API 请求失败，状态码：${res.status}`);
      return new Response('请求 Bing API 失败', { status: res.status });
    }
    const bingData = await res.json();
    const images = bingData.images.map(image => ({ url: `https://cn.bing.com${image.url}` }));
    const returnData = { status: true, message: "操作成功", data: images };
    const response = new Response(JSON.stringify(returnData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=21600',
        'Access-Control-Allow-Origin': '*'
      }
    });
    await cache.put(cacheKey, response.clone());
    console.log('响应数据已缓存');
    return response;
  } catch (error) {
    console.error('请求 Bing API 过程中发生错误:', error);
    return new Response('请求 Bing API 失败', { status: 500 });
  }
}
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
function formatDate(timestamp) {
  if (!timestamp) return '未知时间';
  let date;
  try {
    let msTimestamp;
    if (typeof timestamp === 'number') {
      msTimestamp = timestamp > 9999999999 ? timestamp : timestamp * 1000;
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
      if (!isNaN(date.getTime())) {
        msTimestamp = date.getTime();
      } else {
        const numTimestamp = parseInt(timestamp);
        if (!isNaN(numTimestamp)) {
          msTimestamp = numTimestamp > 9999999999 ? numTimestamp : numTimestamp * 1000;
        } else {
          return '日期无效 (无法解析)';
        }
      }
    } else if (timestamp instanceof Date) {
      msTimestamp = timestamp.getTime();
    } else {
       return '日期无效 (类型错误)';
    }
    if (msTimestamp < 0 || msTimestamp > 8640000000000000) {
        return '日期无效 (范围超限)';
    }
    date = new Date(msTimestamp);
    if (isNaN(date.getTime())) {
        return '日期无效 (转换失败)';
    }
    const beijingTimeOffset = 8 * 60 * 60 * 1000;
    const beijingDate = new Date(date.getTime() + beijingTimeOffset);
    const year = beijingDate.getUTCFullYear();
    const month = (beijingDate.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = beijingDate.getUTCDate().toString().padStart(2, '0');
    const hours = beijingDate.getUTCHours().toString().padStart(2, '0');
    const minutes = beijingDate.getUTCMinutes().toString().padStart(2, '0');
    const seconds = beijingDate.getUTCSeconds().toString().padStart(2, '0');
    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    console.error("formatDate 错误:", error, "原始输入:", timestamp);
    return '日期格式化错误';
  }
}
async function sendMessage(
  chatId,
  text,
  botToken,
  replyToMessageId = null,
  replyMarkup = null
) {
  try {
    const requestBody = {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    };

    if (replyToMessageId) {
      requestBody.reply_to_message_id = replyToMessageId;
    }

    // 新增：允许 sendMessage 附带按钮
    if (replyMarkup) {
      requestBody.reply_markup = replyMarkup;
    }

    const response = await fetch(
      telegramMethodUrl(botToken, 'sendMessage'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorData = await response.text();

      console.error(
        `发送消息失败: HTTP ${response.status}, ${errorData}`
      );

      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('发送消息错误:', error);
    return null;
  }
}
// 生成“暂停并返回主菜单”按钮
function getPauseKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "⏸ 暂停并返回主菜单",
          callback_data: "pause_and_back"
        }
      ]
    ]
  };
}


// 发送需要用户继续输入的提示
async function sendInputPrompt(chatId, text, config) {
  return sendMessage(
    chatId,
    text,
    config.tgBotToken,
    null,
    getPauseKeyboard()
  );
}


// 判断用户是否通过文字取消当前操作
function isPauseCommand(text) {
  const normalized = String(text || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();

  return [
    '/start',
    '/cancel',
    '取消',
    '暂停',
    '返回'
  ].includes(normalized);
}


// 根据等待状态返回对应提示
function getWaitingPromptText(waitingFor) {
  const promptMap = {
    add_user_id:
      "请输入纯数字 Telegram 用户 ID，例如：123456789",

    new_category:
      "请输入新的分类名称",

    edit_suffix_input_file:
      "请输入完整文件名称（包含扩展名）或完整 URL",

    edit_suffix_input_new:
      "请输入新的文件后缀，不要包含扩展名",

    delete_file_input:
      "请输入要删除的完整文件名称或完整 URL",

    new_suffix:
      "请输入新的文件后缀"
  };

  return (
    promptMap[waitingFor] ||
    "请继续输入当前操作需要的文字内容"
  );
}


// 统一清除所有输入等待状态
async function resetWaitingState(
  chatId,
  userSetting,
  config
) {
  await config.database.prepare(`
    UPDATE user_settings
    SET waiting_for = NULL,
        editing_file_id = NULL
    WHERE chat_id = ?
  `).bind(chatId).run();

  if (userSetting) {
    userSetting.waiting_for = null;
    userSetting.editing_file_id = null;
  }
}


// 删除一条 Telegram 消息
async function deleteTelegramMessage(
  chatId,
  messageId,
  botTokenOrConfig
) {
  const telegramConfig =
    botTokenOrConfig && typeof botTokenOrConfig === 'object'
      ? botTokenOrConfig
      : null;

  const botToken = telegramConfig
    ? telegramConfig.tgBotToken
    : botTokenOrConfig;

  if (!chatId || !messageId || !botToken) {
    return false;
  }

  try {
    const response = await fetch(

      telegramMethodUrl(
        botToken,
        'deleteMessage',
        telegramConfig
      ),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: Number(messageId)
        })
      }
    );

    const result = await response.json().catch(() => null);

    if (
      !response.ok ||
      !result ||
      !result.ok
    ) {
      console.warn(
        '[TG Menu] 删除旧消息失败:',
        result || `HTTP ${response.status}`
      );

      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      '[TG Menu] 删除旧消息时出错:',
      error
    );

    return false;
  }
}


// 删除用户刚才点击按钮所在的消息
async function deleteCallbackSourceMessage(update, config) {
  const callbackMessage =
    update &&
    update.callback_query &&
    update.callback_query.message;

  if (!callbackMessage) {
    return false;
  }

  return deleteTelegramMessage(
    callbackMessage.chat.id,
    callbackMessage.message_id,
    config.tgBotToken
  );
}

// 转义动态文本，避免 Telegram HTML 解析失败
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function generateLoginPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录</title>
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .container {
        max-width: 400px;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        padding: 2rem;
        margin: 20px;
      }
      .header {
        margin-bottom: 1.5rem;
        text-align: center;
      }
      h1 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
        font-weight: 600;
      }
      .form-group {
        margin-bottom: 1.5rem;
      }
      .form-group label {
        display: block;
        margin-bottom: 0.5rem;
        color: #2c3e50;
        font-weight: 500;
      }
      .form-group input {
        width: 100%;
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
        background: #fff;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        border-color: #3498db;
        box-shadow: 0 0 8px rgba(52,152,219,0.3);
      }
      .btn-login {
        width: 100%;
        padding: 0.8rem;
        background: #3498db;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.3s ease;
      }
      .btn-login:hover {
        background: #2980b9;
      }
      .error-message {
        color: #e74c3c;
        margin-top: 1rem;
        padding: 0.8rem;
        background: rgba(231, 76, 60, 0.1);
        border-radius: 8px;
        display: none;
      }
      .success-message {
        color: #27ae60;
        margin-top: 1rem;
        padding: 0.8rem;
        background: rgba(39, 174, 96, 0.1);
        border-radius: 8px;
        display: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>登录</h1>
        <p>请输入管理员账号和密码</p>
      </div>
      <form id="loginForm">
        <div class="form-group">
          <label for="username">用户名</label>
          <input type="text" id="username" name="username" required>
        </div>
        <div class="form-group">
          <label for="password">密码</label>
          <input type="password" id="password" name="password" required>
        </div>
        <button type="submit" class="btn-login">登录</button>
      </form>
      <div id="errorMessage" class="error-message"></div>
      <div id="successMessage" class="success-message"></div>
    </div>
    <script>
      const urlParams = new URLSearchParams(window.location.search);
      const redirectPath = urlParams.get('redirect') || '/upload';
      document.getElementById('loginForm').addEventListener('submit', async function(event) {
        event.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorMessage = document.getElementById('errorMessage');
        const successMessage = document.getElementById('successMessage');
        errorMessage.style.display = 'none';
        successMessage.style.display = 'none';
        if (!username || !password) {
          errorMessage.textContent = '请输入用户名和密码';
          errorMessage.style.display = 'block';
          return;
        }
        try {
          const response = await fetch('/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
          });
          if (response.ok) {
            successMessage.textContent = '登录成功，正在跳转...';
            successMessage.style.display = 'block';
            setTimeout(() => {
              window.location.href = redirectPath;
            }, 1000);
          } else {
            const data = await response.text();
            errorMessage.textContent = data || '用户名或密码错误';
            errorMessage.style.display = 'block';
          }
        } catch (error) {
          errorMessage.textContent = '登录请求失败，请稍后重试';
          errorMessage.style.display = 'block';
          console.error('登录错误:', error);
        }
      });
    </script>
  </body>
  </html>`;
}

function generateLargeUploadMessagePage(title, message) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(135deg, #eef4ff, #f7f9fc); color: #1f2937; }
      .card { width: min(520px, 100%); padding: 30px; border-radius: 18px; background: #fff;
        box-shadow: 0 18px 50px rgba(15, 23, 42, .12); text-align: center; }
      h1 { margin: 0 0 14px; font-size: 24px; }
      p { margin: 0; line-height: 1.7; color: #64748b; }
    </style>
  </head>
  <body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
  </html>`;
}

function generateLargeUploadPage({
  token,
  categoryOptions,
  statusPayload,
  chunkSizeBytes,
  maxSizeBytes,
  updateTimeMinutes
}) {
  const tokenJson = JSON.stringify(token);
  const statusJson = JSON.stringify(statusPayload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="机器人专属大文件分片上传页面">
    <title>上传大文件</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; padding: 20px; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
        color: #172033; background: linear-gradient(135deg, #eef5ff 0%, #f7f9fc 55%, #eaf7f5 100%); }
      .container { width: min(760px, 100%); background: rgba(255,255,255,.97); border-radius: 20px;
        box-shadow: 0 22px 60px rgba(30, 41, 59, .14); padding: clamp(20px, 4vw, 36px); }
      h1 { margin: 0 0 8px; font-size: clamp(25px, 5vw, 34px); }
      .subtitle { margin: 0 0 24px; color: #64748b; line-height: 1.6; }
      .notice { margin-bottom: 20px; padding: 12px 14px; border-radius: 12px; background: #fff7ed;
        color: #9a3412; font-size: 14px; line-height: 1.55; }
      label { display: block; margin-bottom: 8px; font-weight: 650; }
      select, input[type="text"] { width: 100%; height: 46px; border: 1px solid #d7deea; border-radius: 11px;
        padding: 0 13px; background: #fff; font-size: 15px; outline: none; }
      select:focus, input[type="text"]:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,.12); }
      .field { margin-bottom: 20px; }
      .upload-area { position: relative; min-height: 180px; border: 2px dashed #9fb0c8; border-radius: 16px;
        display: grid; place-items: center; padding: 24px; text-align: center; background: #f8fafc;
        transition: .2s ease; cursor: pointer; }
      .upload-area.dragover { border-color: #2563eb; background: #eff6ff; transform: translateY(-1px); }
      .upload-area.disabled { opacity: .55; pointer-events: none; }
      .upload-icon { font-size: 38px; margin-bottom: 8px; }
      .upload-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
      .upload-hint { color: #64748b; font-size: 14px; line-height: 1.5; }
      #fileInput { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
      .file-card { display: none; margin-top: 16px; padding: 14px; border: 1px solid #dbe4f0;
        border-radius: 13px; background: #fff; }
      .file-name { font-weight: 700; overflow-wrap: anywhere; }
      .file-meta { color: #64748b; font-size: 13px; margin-top: 4px; }
      .progress-wrap { display: none; margin-top: 20px; }
      .progress-head { display: flex; justify-content: space-between; gap: 14px; margin-bottom: 8px; font-size: 14px; }
      .progress-bar { height: 18px; background: #e7edf5; border-radius: 999px; overflow: hidden; }
      .progress-track { height: 100%; width: 0; border-radius: inherit;
        background: linear-gradient(90deg, #2563eb, #06b6d4); transition: width .18s ease; }
      .progress-detail { margin-top: 9px; color: #64748b; font-size: 13px; line-height: 1.55; }
      .status { display: none; margin-top: 18px; padding: 12px 14px; border-radius: 11px; line-height: 1.55; }
      .status.info { display: block; color: #1e40af; background: #eff6ff; }
      .status.error { display: block; color: #991b1b; background: #fef2f2; }
      .status.success { display: block; color: #166534; background: #f0fdf4; }
      .result { margin-top: 24px; }
      .result-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; }
      button { height: 46px; border: 0; border-radius: 11px; padding: 0 18px; font-weight: 700; cursor: pointer;
        color: #fff; background: #2563eb; }
      button:disabled { opacity: .55; cursor: not-allowed; }
      .footer { margin-top: 20px; color: #94a3b8; font-size: 12px; line-height: 1.6; text-align: center; }
      @media (max-width: 560px) { .result-row { grid-template-columns: 1fr; } button { width: 100%; } }
    </style>
  </head>
  <body>
    <main class="container">
      <h1>📤 上传大文件</h1>
      <p class="subtitle">机器人专属临时页面 · 浏览器将文件按 ${Math.round(chunkSizeBytes / 1024 / 1024)} MB 分片保存到 Telegram</p>
      <div class="notice">页面在尚未开始上传时有效 ${Number(updateTimeMinutes)} 分钟首个分片成功后不再受该时限影响；关闭页面不会删除已上传分片，完成后机器人也会发送永久直链</div>

      <div class="field">
        <label for="categorySelect">选择分类</label>
        <select id="categorySelect">${categoryOptions || '<option value="">默认分类</option>'}</select>
      </div>

      <div id="uploadArea" class="upload-area">
        <input id="fileInput" type="file">
        <div>
          <div class="upload-icon">☁️</div>
          <div class="upload-title">点击选择文件，或拖放到这里</div>
          <div class="upload-hint">最大允许 ${Math.round(maxSizeBytes / 1024 / 1024)} MB；推荐用于超过 20 MB 的文件</div>
        </div>
      </div>

      <div id="fileCard" class="file-card">
        <div id="fileName" class="file-name"></div>
        <div id="fileMeta" class="file-meta"></div>
      </div>

      <section id="progressWrap" class="progress-wrap">
        <div class="progress-head"><span id="progressLabel">准备上传</span><strong id="progressPercent">0%</strong></div>
        <div class="progress-bar"><div id="progressTrack" class="progress-track"></div></div>
        <div id="progressDetail" class="progress-detail"></div>
      </section>

      <div id="statusBox" class="status"></div>

      <section class="result">
        <label for="resultUrl">返回直链</label>
        <div class="result-row">
          <input id="resultUrl" type="text" readonly placeholder="上传完成后将在这里显示直链">
          <button id="copyButton" type="button" disabled>复制直链</button>
        </div>
      </section>
      <div class="footer">临时页面失效或会话记录被清理，不会删除已经生成的文件和直链</div>
    </main>

    <script>
      const TOKEN = ${tokenJson};
      const INITIAL_STATUS = ${statusJson};
      const CHUNK_SIZE = ${Number(chunkSizeBytes)};
      const MAX_SIZE = ${Number(maxSizeBytes)};
      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const categorySelect = document.getElementById('categorySelect');
      const fileCard = document.getElementById('fileCard');
      const fileNameEl = document.getElementById('fileName');
      const fileMetaEl = document.getElementById('fileMeta');
      const progressWrap = document.getElementById('progressWrap');
      const progressTrack = document.getElementById('progressTrack');
      const progressPercent = document.getElementById('progressPercent');
      const progressLabel = document.getElementById('progressLabel');
      const progressDetail = document.getElementById('progressDetail');
      const statusBox = document.getElementById('statusBox');
      const resultUrl = document.getElementById('resultUrl');
      const copyButton = document.getElementById('copyButton');
      let busy = false;
      let currentStatus = INITIAL_STATUS;
      let statusPollTimer = null;
      let closeScheduled = false;

      function formatSize(bytes) {
        const value = Number(bytes || 0);
        if (value < 1024) return value + ' B';
        const units = ['KB', 'MB', 'GB', 'TB'];
        let size = value / 1024;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
        return size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2) + ' ' + units[index];
      }

      function setStatus(message, type = 'info') {
        statusBox.className = 'status ' + type;
        statusBox.textContent = message;
      }

      function clearStatus() {
        statusBox.className = 'status';
        statusBox.textContent = '';
      }

      function setProgress(percent, label, detail) {
        const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));
        progressWrap.style.display = 'block';
        progressTrack.style.width = safePercent + '%';
        progressPercent.textContent = safePercent.toFixed(safePercent < 100 ? 1 : 0) + '%';
        progressLabel.textContent = label || '正在上传';
        progressDetail.textContent = detail || '';
      }

      function showResult(url) {
        resultUrl.value = url || '';
        copyButton.disabled = !url;
        if (url) {
          uploadArea.classList.add('disabled');
          fileInput.disabled = true;
          categorySelect.disabled = true;
          stopStatusPolling();
        }
      }

      function stopStatusPolling() {
        if (statusPollTimer) {
          clearInterval(statusPollTimer);
          statusPollTimer = null;
        }
      }

      function closeCancelledPage() {
        if (closeScheduled) return;
        closeScheduled = true;
        stopStatusPolling();
        uploadArea.classList.add('disabled');
        fileInput.disabled = true;
        categorySelect.disabled = true;

        // 先让用户看到取消原因，再尝试关闭 Telegram WebApp/内置浏览器页面
        setTimeout(() => {
          try {
            if (
              window.Telegram &&
              window.Telegram.WebApp &&
              typeof window.Telegram.WebApp.close === 'function'
            ) {
              window.Telegram.WebApp.close();
            }
          } catch (_) {}

          try { window.close(); } catch (_) {}

          // 普通浏览器通常禁止脚本关闭非脚本打开的标签页，退化为返回上一页；
          // 若仍无法返回，则清空当前页面，避免继续提交上传
          setTimeout(() => {
            try {
              if (history.length > 1) {
                history.back();
                return;
              }
            } catch (_) {}
            document.body.innerHTML =
              '<main style="font-family:sans-serif;padding:32px;text-align:center">' +
              '<h2>上传任务已取消</h2><p>该页面已关闭，请返回 Telegram</p></main>';
          }, 300);
        }, 1800);
      }

      async function fetchStatus() {
        const response = await fetch('/large-upload/status?token=' + encodeURIComponent(TOKEN), {
          cache: 'no-store'
        });
        const data = await response.json();
        if (!response.ok || !data.status) throw new Error(data.error || '读取上传状态失败');
        currentStatus = data.session;
        return currentStatus;
      }

      function applyStatus(status) {
        if (!status) return;
        if (status.cancelled || status.status === 'cancelled' || status.closePage) {
          const reason = status.error || '两个分片间隔超过 10 分钟，任务已取消，全部分片已删除';
          setProgress(0, '任务已取消', '已清理该任务的全部 Telegram 分片');
          setStatus(reason + ' 页面即将关闭', 'error');
          closeCancelledPage();
          return;
        }
        if (status.resultUrl) {
          showResult(status.resultUrl);
          setProgress(100, '上传完成', '直链已经生成，并已发送到机器人');
          setStatus('上传完成，可以复制直链', 'success');
          return;
        }
        if (status.fileName) {
          fileCard.style.display = 'block';
          fileNameEl.textContent = status.fileName;
          fileMetaEl.textContent = formatSize(status.fileSize) + ' · 已完成 ' + status.uploadedChunks + '/' + status.totalChunks + ' 个分片';
        }
        if (status.status === 'uploading' || status.status === 'finalizing') {
          setProgress(status.progress, status.status === 'finalizing' ? '正在生成直链' : '已有上传进度',
            formatSize(status.uploadedBytes) + ' / ' + formatSize(status.fileSize));
          const deadlineText = status.chunkDeadlineAt
            ? '下一片须在 ' + new Date(status.chunkDeadlineAt).toLocaleTimeString() + ' 前完成'
            : '';
          setStatus(
            '页面关闭不会立即删除分片；若相邻分片超过 10 分钟，任务将自动取消并清理' + deadlineText,
            'info'
          );
        } else if (status.error) {
          setStatus(status.error, 'error');
        }
      }

      function uploadChunkWithProgress(formData, baseBytes, fileSize, chunkIndex, totalChunks) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/large-upload/chunk?token=' + encodeURIComponent(TOKEN));
          xhr.responseType = 'json';
          xhr.upload.onprogress = event => {
            if (!event.lengthComputable) return;
            const uploaded = Math.min(fileSize, baseBytes + event.loaded);
            const percent = uploaded / fileSize * 100;
            setProgress(percent, '正在上传第 ' + (chunkIndex + 1) + '/' + totalChunks + ' 片',
              formatSize(uploaded) + ' / ' + formatSize(fileSize));
          };
          xhr.onload = () => {
            const data = xhr.response || {};
            if (xhr.status >= 200 && xhr.status < 300 && data.status) {
              resolve(data);
            } else {
              if (data.cancelled || data.closePage || xhr.status === 410) {
                applyStatus({ status: 'cancelled', cancelled: true, closePage: true, error: data.error });
              }
              reject(new Error(data.error || '分片上传失败（HTTP ' + xhr.status + '）'));
            }
          };
          xhr.onerror = () => reject(new Error('网络连接中断'));
          xhr.send(formData);
        });
      }

      async function uploadFile(file) {
        if (busy) return;
        if (!file) return;
        if (file.size <= 0) return setStatus('文件为空，无法上传', 'error');
        if (file.size > MAX_SIZE) return setStatus('文件超过最大限制：' + formatSize(MAX_SIZE), 'error');
        busy = true;
        clearStatus();
        uploadArea.classList.add('disabled');
        fileInput.disabled = true;
        categorySelect.disabled = true;
        fileCard.style.display = 'block';
        fileNameEl.textContent = file.name;
        fileMetaEl.textContent = formatSize(file.size) + ' · ' + (file.type || 'application/octet-stream');

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const startTime = Date.now();
        try {
          const latest = await fetchStatus();
          if (latest.resultUrl) {
            applyStatus(latest);
            return;
          }
          if (latest.fileName && (latest.fileName !== file.name || Number(latest.fileSize) !== Number(file.size))) {
            throw new Error('该页面已有另一个文件的上传进度，请重新从机器人生成页面');
          }
          const completed = new Set((latest.uploadedIndexes || []).map(Number));
          let uploadedBytes = Number(latest.uploadedBytes || 0);

          for (let index = 0; index < totalChunks; index++) {
            if (completed.has(index)) continue;
            const start = index * CHUNK_SIZE;
            const end = Math.min(file.size, start + CHUNK_SIZE);
            const chunk = file.slice(start, end);
            const formData = new FormData();
            formData.append('token', TOKEN);
            formData.append('chunk', chunk, file.name + '.part' + String(index + 1).padStart(5, '0'));
            formData.append('chunk_index', String(index));
            formData.append('total_chunks', String(totalChunks));
            formData.append('file_name', file.name);
            formData.append('file_size', String(file.size));
            formData.append('mime_type', file.type || 'application/octet-stream');
            formData.append('category', categorySelect.value || '');

            const result = await uploadChunkWithProgress(
              formData,
              uploadedBytes,
              file.size,
              index,
              totalChunks
            );
            uploadedBytes = Number(result.uploadedBytes || end);
            const elapsedSeconds = Math.max(1, (Date.now() - startTime) / 1000);
            const speed = uploadedBytes / elapsedSeconds;
            setProgress(result.progress, '已完成 ' + result.uploadedChunks + '/' + totalChunks + ' 个分片',
              formatSize(uploadedBytes) + ' / ' + formatSize(file.size) + ' · ' + formatSize(speed) + '/s');
          }

          setProgress(99.8, '正在校验分片并生成直链', '请勿关闭页面');
          const completeResponse = await fetch('/large-upload/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: TOKEN })
          });
          const completeData = await completeResponse.json();
          if (!completeResponse.ok || !completeData.status) {
            throw new Error(completeData.error || '生成直链失败');
          }
          showResult(completeData.url);
          setProgress(100, '上传完成', '共 ' + completeData.chunkCount + ' 个分片');
          setStatus('上传完成，直链已生成，同时已发送到机器人', 'success');
        } catch (error) {
          setStatus(error.message || '上传失败', 'error');
          const latest = await fetchStatus().catch(() => null);
          if (latest) applyStatus(latest);
        } finally {
          busy = false;
          if (!resultUrl.value && !closeScheduled) {
            uploadArea.classList.remove('disabled');
            fileInput.disabled = false;
            categorySelect.disabled = false;
          }
        }
      }

      fileInput.addEventListener('change', event => uploadFile(event.target.files && event.target.files[0]));
      ['dragenter', 'dragover'].forEach(name => uploadArea.addEventListener(name, event => {
        event.preventDefault();
        if (!busy) uploadArea.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach(name => uploadArea.addEventListener(name, event => {
        event.preventDefault();
        uploadArea.classList.remove('dragover');
      }));
      uploadArea.addEventListener('drop', event => {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) uploadFile(file);
      });
      copyButton.addEventListener('click', async () => {
        if (!resultUrl.value) return;
        try {
          await navigator.clipboard.writeText(resultUrl.value);
          copyButton.textContent = '已复制';
          setTimeout(() => { copyButton.textContent = '复制直链'; }, 1200);
        } catch (_) {
          resultUrl.select();
          document.execCommand('copy');
        }
      });

      applyStatus(INITIAL_STATUS);
      if (!INITIAL_STATUS.resultUrl && !INITIAL_STATUS.cancelled) {
        statusPollTimer = setInterval(async () => {
          try {
            const latest = await fetchStatus();
            applyStatus(latest);
          } catch (_) {
            // 临时网络错误不打断正在进行的分片请求；下轮继续检查
          }
        }, 5000);
      }
    </script>
  </body>
  </html>`;
}

function generateUploadPage(categoryOptions, storageType) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件上传</title>
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .container {
        max-width: 900px;
        width: 100%;
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        padding: 2rem;
        margin: 20px;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
      }
      h1 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
        font-weight: 600;
      }
      .admin-link {
        color: #3498db;
        text-decoration: none;
        font-size: 1rem;
        transition: color 0.3s ease;
      }
      .admin-link:hover {
        color: #2980b9;
      }
      .options {
        display: flex;
        gap: 1rem;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
      }
      .category-select, .new-category input {
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
        background: #fff;
        transition: border-color 0.3s ease, box-shadow 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .category-select:focus, .new-category input:focus {
        outline: none;
        border-color: #3498db;
        box-shadow: 0 0 8px rgba(52,152,219,0.3);
      }
      .new-category {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .new-category button {
        padding: 0.8rem 1.5rem;
        background: #2ecc71;
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: background 0.3s ease, transform 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      }
      .new-category button:hover {
        background: #27ae60;
        transform: translateY(-2px);
      }
      .storage-toggle {
        display: flex;
        gap: 0.5rem;
      }
      .storage-btn {
        padding: 0.8rem 1.5rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        background: #fff;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .storage-btn.active {
        background: #3498db;
        color: white;
        border-color: #3498db;
      }
      .storage-btn:hover:not(.active) {
        background: #ecf0f1;
        transform: translateY(-2px);
      }
      .upload-area {
        border: 2px dashed #b2bec3;
        padding: 2rem;
        text-align: center;
        margin-bottom: 1.5rem;
        border-radius: 10px;
        background: #fff;
        transition: all 0.3s ease;
        box-shadow: 0 2px 10px rgba(0,0,0,0.05);
      }
      .upload-area.dragover {
        border-color: #3498db;
        background: #f8f9fa;
        box-shadow: 0 0 15px rgba(52,152,219,0.2);
      }
      .upload-area p {
        margin: 0;
        color: #7f8c8d;
        font-size: 1.1rem;
      }
      .preview-area {
        margin-top: 1rem;
      }
      .preview-item {
        display: flex;
        align-items: center;
        padding: 1rem;
        background: #fff;
        border-radius: 8px;
        margin-bottom: 1rem;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
        transition: transform 0.3s ease;
      }
      .preview-item:hover {
        transform: translateY(-2px);
      }
      .preview-item img {
        max-width: 100px;
        max-height: 100px;
        margin-right: 1rem;
        border-radius: 5px;
      }
      .preview-item .info {
        flex-grow: 1;
        color: #2c3e50;
      }
      .progress-bar {
        height: 20px;
        background: #ecf0f1;
        border-radius: 10px;
        margin: 8px 0;
        overflow: hidden;
        position: relative;
      }
      .progress-track {
        height: 100%;
        background: #3498db;
        transition: width 0.3s ease;
        width: 0;
      }
      .progress-text {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        color: #fff;
        font-size: 12px;
      }
      .success .progress-track {
        background: #2ecc71;
      }
      .error .progress-track {
        background: #e74c3c;
      }
      .url-area {
        margin-top: 1.5rem;
      }
      .url-area textarea {
        width: 100%;
        min-height: 100px;
        padding: 0.8rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        background: #fff;
        font-size: 0.9rem;
        resize: vertical;
        transition: border-color 0.3s ease;
      }
      .url-area textarea:focus {
        outline: none;
        border-color: #3498db;
      }
      .button-group {
        margin-top: 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 1rem;
      }
      .button-container button {
        padding: 0.7rem 1.2rem;
        border: none;
        border-radius: 8px;
        background: #3498db;
        color: white;
        cursor: pointer;
        transition: background 0.3s ease, transform 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      }
      .button-container button:hover {
        background: #2980b9;
        transform: translateY(-2px);
      }
      .copyright {
        font-size: 0.8rem;
        color: #7f8c8d;
      }
      .copyright a {
        color: #3498db;
        text-decoration: none;
      }
      .copyright a:hover {
        text-decoration: underline;
      }
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 1rem;
      }
      .modal-message {
        margin-bottom: 1.5rem;
        color: #34495e;
        line-height: 1.5;
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: center;
      }
      .modal-button {
        padding: 0.8rem 1.8rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.95rem;
        font-weight: 500;
      }
      .modal-confirm {
        background: #3498db;
        color: white;
      }
      .modal-cancel {
        background: #95a5a6;
        color: white;
      }
      .modal-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .modal-confirm:hover {
        background: #2980b9;
      }
      .modal-cancel:hover {
        background: #7f8c8d;
      }
      @media (max-width: 768px) {
        body {
          padding: 10px;
          align-items: flex-start;
        }
        .container {
          padding: 1rem;
          margin: 10px;
        }
        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .options {
          flex-direction: column;
          align-items: stretch;
        }
        .new-category {
           flex-direction: column;
           align-items: stretch;
           width: 100%;
        }
        .new-category input {
           width: auto;
        }
        .storage-toggle {
           justify-content: center;
        }
        .upload-area p {
           font-size: 1rem;
        }
        .button-group {
          flex-direction: column;
          align-items: stretch;
          gap: 0.5rem;
        }
        .button-container {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          justify-content: center;
        }
        .button-container button {
          flex-grow: 1;
        }
        .copyright {
           text-align: center;
           margin-top: 1rem;
        }
        .modal-content {
           padding: 1.5rem;
        }
      }
      @media (max-width: 480px) {
        .storage-btn {
           padding: 0.6rem 1rem;
           font-size: 0.9rem;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>文件上传</h1>
        <a href="/admin" class="admin-link">管理文件</a>
      </div>
      <div class="options">
        <select id="categorySelect" class="category-select">
          <option value="">选择分类</option>
          ${categoryOptions}
        </select>
        <div class="new-category">
          <input type="text" id="newCategoryInput" placeholder="输入新分类名称">
          <button onclick="createNewCategory()">新建分类</button>
        </div>
        <div class="storage-toggle">
          <button class="storage-btn ${storageType === 'telegram' ? 'active' : ''}" data-storage="telegram">Telegram</button>
          <button class="storage-btn ${storageType === 'r2' ? 'active' : ''}" data-storage="r2">R2</button>
        </div>
      </div>
      <div class="upload-area" id="uploadArea">
        <p>点击选择 或 拖拽文件到此处</p>
        <input type="file" id="fileInput" multiple style="display: none">
      </div>
      <div class="preview-area" id="previewArea"></div>
      <div class="url-area">
        <textarea id="urlArea" readonly placeholder="上传完成后的链接将显示在这里"></textarea>
        <div class="button-group">
          <div class="button-container">
            <button onclick="copyUrls('url')">复制URL</button>
            <button onclick="copyUrls('markdown')">复制Markdown</button>
            <button onclick="copyUrls('html')">复制HTML</button>
          </div>
        </div>
      </div>
      <!-- 通用确认弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">提示</h3>
          <p class="modal-message" id="confirmModalMessage"></p>
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      async function setBingBackground() {
        try {
          const response = await fetch('/bing', { cache: 'no-store' });
          const data = await response.json();
          if (data.status && data.data && data.data.length > 0) {
            const randomIndex = Math.floor(Math.random() * data.data.length);
            document.body.style.backgroundImage = \`url(\${data.data[randomIndex].url})\`;
          }
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setBingBackground();
      setInterval(setBingBackground, 3600000);
      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const previewArea = document.getElementById('previewArea');
      const urlArea = document.getElementById('urlArea');
      const categorySelect = document.getElementById('categorySelect');
      const newCategoryInput = document.getElementById('newCategoryInput');
      const storageButtons = document.querySelectorAll('.storage-btn');
      const confirmModal = document.getElementById('confirmModal');
      const confirmModalMessage = document.getElementById('confirmModalMessage');
      const confirmModalConfirm = document.getElementById('confirmModalConfirm');
      const confirmModalCancel = document.getElementById('confirmModalCancel');
      let uploadedUrls = [];
      let currentConfirmCallback = null;
      storageButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          storageButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
      async function createNewCategory() {
        const categoryName = newCategoryInput.value.trim();
        if (!categoryName) {
          showConfirmModal('分类名称不能为空！', null, true);
          return;
        }
        try {
          const response = await fetch('/create-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: categoryName })
          });
          const data = await response.json();
          if (data.status === 1) {
            const option = document.createElement('option');
            option.value = data.category.id;
            option.textContent = data.category.name;
            categorySelect.appendChild(option);
            categorySelect.value = data.category.id;
            newCategoryInput.value = '';
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('创建分类失败：' + error.message, null, true);
        }
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        confirmModal.classList.remove('show');
      }
      confirmModalConfirm.addEventListener('click', () => {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      });
      confirmModalCancel.addEventListener('click', closeConfirmModal);
      window.addEventListener('click', (event) => {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
      });
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
      });
      function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
      }
      ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, highlight, false);
      });
      ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, unhighlight, false);
      });
      function highlight(e) {
        uploadArea.classList.add('dragover');
      }
      function unhighlight(e) {
        uploadArea.classList.remove('dragover');
      }
      uploadArea.addEventListener('drop', handleDrop, false);
      uploadArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFiles);
      function handleDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        handleFiles({ target: { files } });
      }
      document.addEventListener('paste', async (e) => {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        for (let item of items) {
          if (item.kind === 'file') {
            const file = item.getAsFile();
            await uploadFile(file);
          }
        }
      });
      let runtimeConfigPromise = null;
      function getRuntimeConfig() {
        if (!runtimeConfigPromise) {
          runtimeConfigPromise = fetch('/config', { cache: 'no-store' }).then(async response => {
            if (!response.ok) throw new Error('读取上传配置失败');
            return response.json();
          });
        }
        return runtimeConfigPromise;
      }
      async function handleFiles(e) {
        const config = await getRuntimeConfig();
        const files = Array.from(e.target.files || []);
        for (const file of files) {
          if (file.size > config.maxSizeMB * 1024 * 1024) {
            showConfirmModal('文件超过' + config.maxSizeMB + 'MB限制', null, true);
            continue;
          }
          await uploadFile(file, config);
        }
      }
      async function uploadFile(file, runtimeConfig = null) {
        const config = runtimeConfig || await getRuntimeConfig();
        const preview = createPreview(file);
        previewArea.appendChild(preview);
        const storageType = document.querySelector('.storage-btn.active').dataset.storage;
        try {
          let data;
          if (
            storageType === 'telegram' &&
            file.size > config.telegramChunkSizeMB * 1024 * 1024
          ) {
            data = await uploadFileInChunks(file, preview, config);
          } else {
            data = await uploadFileDirect(file, preview, storageType);
          }
          if (!data || data.status !== 1) {
            throw new Error((data && (data.error || data.msg)) || '上传失败');
          }
          const progressTrack = preview.querySelector('.progress-track');
          const progressText = preview.querySelector('.progress-text');
          progressTrack.style.width = '100%';
          progressText.textContent = data.msg || '✔ 上传成功';
          uploadedUrls.push(data.url);
          updateUrlArea();
          preview.classList.add('success');
        } catch (error) {
          preview.querySelector('.progress-text').textContent = '✗ ' + error.message;
          preview.classList.add('error');
        }
      }
      function uploadFileDirect(file, preview, storageType) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const progressTrack = preview.querySelector('.progress-track');
          const progressText = preview.querySelector('.progress-text');
          xhr.upload.addEventListener('progress', event => {
            if (!event.lengthComputable) return;
            const percent = Math.round(event.loaded / event.total * 100);
            progressTrack.style.width = percent + '%';
            progressText.textContent = percent + '%';
          });
          xhr.addEventListener('load', () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (xhr.status < 200 || xhr.status >= 300) {
                reject(new Error(data.error || data.msg || ('HTTP ' + xhr.status)));
                return;
              }
              resolve(data);
            } catch (error) {
              reject(new Error('响应解析失败'));
            }
          });
          xhr.addEventListener('error', () => reject(new Error('网络错误')));
          const formData = new FormData();
          formData.append('file', file);
          formData.append('category', categorySelect.value);
          formData.append('storage_type', storageType);
          xhr.open('POST', '/upload');
          xhr.send(formData);
        });
      }
      function createUploadId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID().replace(/-/g, '_');
        }
        const random = Math.random().toString(36).slice(2);
        return Date.now().toString(36) + '_' + random + '_' + Math.random().toString(36).slice(2);
      }
      function uploadChunkRequest(formData, preview, completedBytes, fileSize) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const progressTrack = preview.querySelector('.progress-track');
          const progressText = preview.querySelector('.progress-text');
          xhr.upload.addEventListener('progress', event => {
            if (!event.lengthComputable) return;
            const loaded = Math.min(fileSize, completedBytes + event.loaded);
            const percent = Math.floor(loaded / fileSize * 100);
            progressTrack.style.width = percent + '%';
            progressText.textContent = '分片上传 ' + percent + '%';
          });
          xhr.addEventListener('load', () => {
            try {
              const data = JSON.parse(xhr.responseText);
              if (xhr.status < 200 || xhr.status >= 300 || data.status !== 1) {
                reject(new Error(data.error || ('分片上传失败 HTTP ' + xhr.status)));
                return;
              }
              resolve(data);
            } catch (_) {
              reject(new Error('分片响应解析失败'));
            }
          });
          xhr.addEventListener('error', () => reject(new Error('分片上传网络错误')));
          xhr.open('POST', '/upload-chunk');
          xhr.send(formData);
        });
      }
      async function uploadFileInChunks(file, preview, config) {
        const chunkSize = config.telegramChunkSizeMB * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        const uploadId = createUploadId();
        const keyParts = file.name.split('.');
        const extension = keyParts.length > 1 ? keyParts.pop().replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : 'bin';
        const key = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + (extension || 'bin');
        let completedBytes = 0;
        try {
          for (let index = 0; index < totalChunks; index++) {
            const start = index * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);
            let lastError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const formData = new FormData();
                formData.append('upload_id', uploadId);
                formData.append('chunk_index', String(index));
                formData.append('total_chunks', String(totalChunks));
                formData.append('file_name', file.name);
                formData.append('file_size', String(file.size));
                formData.append('chunk', chunk, file.name + '.part' + String(index + 1).padStart(5, '0'));
                await uploadChunkRequest(formData, preview, completedBytes, file.size);
                lastError = null;
                break;
              } catch (error) {
                lastError = error;
                if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 800));
              }
            }
            if (lastError) throw lastError;
            completedBytes += chunk.size;
          }

          const response = await fetch('/upload-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              upload_id: uploadId,
              file_name: file.name,
              file_size: file.size,
              mime_type: file.type || 'application/octet-stream',
              total_chunks: totalChunks,
              category: categorySelect.value,
              key
            })
          });
          const data = await response.json();
          if (!response.ok || data.status !== 1) {
            throw new Error(data.error || data.msg || '合并分片失败');
          }
          return data;
        } catch (error) {
          fetch('/upload-abort', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upload_id: uploadId })
          }).catch(() => {});
          throw error;
        }
      }
      function createPreview(file) {
        const div = document.createElement('div');
        div.className = 'preview-item';
        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          div.appendChild(img);
        }
        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = \`
          <div>\${file.name}</div>
          <div>\${formatSize(file.size)}</div>
          <div class="progress-bar">
            <div class="progress-track"></div>
            <span class="progress-text">0%</span>
          </div>
        \`;
        div.appendChild(info);
        return div;
      }
      function formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return \`\${size.toFixed(2)} \${units[unitIndex]}\`;
      }
      function updateUrlArea() {
        urlArea.value = uploadedUrls.join('\\n');
      }
      function copyUrls(format) {
        let text = '';
        switch (format) {
          case 'url':
            text = uploadedUrls.join('\\n');
            break;
          case 'markdown':
            text = uploadedUrls.map(url => \`![](\${url})\`).join('\\n');
            break;
          case 'html':
            text = uploadedUrls.map(url => \`<img src="\${url}" />\`).join('\\n');
            break;
        }
        navigator.clipboard.writeText(text)
          .then(() => {
            showConfirmModal('已复制到剪贴板', null, true);
          })
          .catch(() => {
            showConfirmModal('复制失败，请手动复制', null, true);
          });
      }
    </script>
  </body>
  </html>`;
}
function generateUserManagementPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>用户管理</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      font-family: Arial, "Microsoft YaHei", sans-serif;
      background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
      color: #2c3e50;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
    }

    .header,
    .panel {
      background: rgba(255, 255, 255, 0.96);
      border-radius: 14px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      padding: 22px;
      margin-bottom: 20px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
    }

    h1,
    h2 {
      margin-top: 0;
    }

    h1 {
      margin-bottom: 0;
      font-size: 28px;
    }

    h2 {
      font-size: 20px;
      margin-bottom: 16px;
    }

    .back-button {
      display: inline-block;
      padding: 10px 16px;
      border-radius: 8px;
      text-decoration: none;
      color: white;
      background: #3498db;
    }

    .add-form {
      display: flex;
      gap: 12px;
    }

    .add-form input {
      flex: 1;
      min-width: 0;
      padding: 12px;
      border: 2px solid #dfe6e9;
      border-radius: 8px;
      font-size: 16px;
    }

    .add-form input:focus {
      outline: none;
      border-color: #3498db;
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 11px 18px;
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
    }

    .add-button {
      color: white;
      background: #27ae60;
    }

    .delete-button {
      color: white;
      background: #e74c3c;
    }

    .refresh-button {
      color: white;
      background: #7f8c8d;
    }

    .message {
      display: none;
      margin-top: 14px;
      padding: 12px;
      border-radius: 8px;
    }

    .message.success {
      display: block;
      background: #eafaf1;
      color: #1e8449;
    }

    .message.error {
      display: block;
      background: #fdecea;
      color: #c0392b;
    }

    .admin-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .admin-item {
      padding: 10px 14px;
      border-radius: 8px;
      background: #f3e5f5;
      color: #7d3c98;
      font-weight: 600;
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 15px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th,
    td {
      padding: 12px;
      border-bottom: 1px solid #ecf0f1;
      text-align: left;
      word-break: break-all;
    }

    th {
      background: #f8f9fa;
    }

    .empty {
      padding: 20px;
      text-align: center;
      color: #7f8c8d;
    }

    .hint {
      color: #7f8c8d;
      font-size: 14px;
      line-height: 1.7;
    }

    @media (max-width: 700px) {
      body {
        padding: 10px;
      }

      .header {
        flex-direction: column;
        align-items: stretch;
      }

      .back-button {
        text-align: center;
      }

      .add-form {
        flex-direction: column;
      }

      .toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .refresh-button {
        width: 100%;
      }

      table,
      thead,
      tbody,
      tr,
      th,
      td {
        display: block;
      }

      thead {
        display: none;
      }

      tr {
        padding: 12px;
        margin-bottom: 12px;
        border: 1px solid #ecf0f1;
        border-radius: 8px;
      }

      td {
        border-bottom: 0;
        padding: 7px 0;
      }
    }
  </style>
</head>

<body>
  <div class="container">
    <div class="header">
      <h1>用户管理</h1>
      <a href="/admin" class="back-button">
        返回文件管理
      </a>
    </div>

    <div class="panel">
      <h2>添加用户</h2>

      <div class="add-form">
        <input
          type="text"
          id="chatIdInput"
          inputmode="numeric"
          placeholder="输入 Telegram 用户 ID，例如 123456789"
        >

        <button
          type="button"
          class="add-button"
          id="addUserButton"
        >
          添加用户
        </button>
      </div>

      <div id="messageBox" class="message"></div>

      <p class="hint">
        只填写 Telegram 用户 ID，不要填写用户名或 @username
        TG_ADMIN_ID 管理员无需重复添加
      </p>
    </div>

    <div class="panel">
      <h2>TG_ADMIN_ID 管理员</h2>
      <div id="adminList" class="admin-list"></div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <h2 style="margin:0;">
          普通授权用户
        </h2>

        <button
          type="button"
          class="refresh-button"
          id="refreshButton"
        >
          刷新列表
        </button>
      </div>

      <div id="userTableContainer">
        <div class="empty">正在加载……</div>
      </div>
    </div>
  </div>

  <script>
    const chatIdInput =
      document.getElementById('chatIdInput');

    const addUserButton =
      document.getElementById('addUserButton');

    const refreshButton =
      document.getElementById('refreshButton');

    const messageBox =
      document.getElementById('messageBox');

    const adminList =
      document.getElementById('adminList');

    const userTableContainer =
      document.getElementById('userTableContainer');

    function showMessage(text, type) {
      messageBox.textContent = text;
      messageBox.className =
        'message ' + (type || 'success');
    }

    function formatTime(timestamp) {
      const value = Number(timestamp || 0);

      if (!value) {
        return '-';
      }

      return new Date(value).toLocaleString('zh-CN');
    }

    async function parseResponse(response) {
      let data = null;

      try {
        data = await response.json();
      } catch (error) {
        throw new Error('服务器返回格式错误');
      }

      if (!response.ok || !data || data.status !== 1) {
        throw new Error(
          data && (data.error || data.message)
            ? (data.error || data.message)
            : '请求失败'
        );
      }

      return data;
    }

    function renderAdmins(admins) {
      adminList.innerHTML = '';

      if (!admins || admins.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '尚未配置 TG_ADMIN_ID';
        adminList.appendChild(empty);
        return;
      }

      admins.forEach(function(adminId) {
        const item = document.createElement('div');
        item.className = 'admin-item';
        item.textContent = adminId;
        adminList.appendChild(item);
      });
    }

    function renderUsers(users) {
      userTableContainer.innerHTML = '';

      if (!users || users.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '当前没有普通授权用户';
        userTableContainer.appendChild(empty);
        return;
      }

      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');

      [
        'Telegram 用户 ID',
        '添加来源',
        '添加时间',
        '操作'
      ].forEach(function(title) {
        const th = document.createElement('th');
        th.textContent = title;
        headRow.appendChild(th);
      });

      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      users.forEach(function(user) {
        const row = document.createElement('tr');

        const idCell = document.createElement('td');
        idCell.textContent = user.chat_id || '-';

        const sourceCell = document.createElement('td');
        sourceCell.textContent = user.added_by || '-';

        const timeCell = document.createElement('td');
        timeCell.textContent = formatTime(user.created_at);

        const actionCell = document.createElement('td');
        const deleteButton = document.createElement('button');

        deleteButton.type = 'button';
        deleteButton.className = 'delete-button';
        deleteButton.textContent = '删除';

        deleteButton.addEventListener('click', function() {
          deleteUser(user.chat_id);
        });

        actionCell.appendChild(deleteButton);

        row.appendChild(idCell);
        row.appendChild(sourceCell);
        row.appendChild(timeCell);
        row.appendChild(actionCell);

        tbody.appendChild(row);
      });

      table.appendChild(tbody);
      userTableContainer.appendChild(table);
    }

    async function loadUsers() {
      userTableContainer.innerHTML =
        '<div class="empty">正在加载……</div>';

      try {
        const response = await fetch('/api/users', {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          cache: 'no-store'
        });

        const data = await parseResponse(response);

        renderAdmins(data.admins || []);
        renderUsers(data.users || []);
      } catch (error) {
        userTableContainer.innerHTML = '';

        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent =
          '加载失败：' + error.message;

        userTableContainer.appendChild(empty);
      }
    }

    async function addUser() {
      const chatId = chatIdInput.value.trim();

      if (!/^\\d{5,20}$/.test(chatId)) {
        showMessage(
          '请输入正确的纯数字 Telegram 用户 ID',
          'error'
        );
        return;
      }

      addUserButton.disabled = true;

      try {
        const response = await fetch('/api/users/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId
          })
        });

        const data = await parseResponse(response);

        showMessage(
          data.message || '用户添加成功',
          'success'
        );

        chatIdInput.value = '';

        await loadUsers();
      } catch (error) {
        showMessage(
          '添加失败：' + error.message,
          'error'
        );
      } finally {
        addUserButton.disabled = false;
      }
    }

    async function deleteUser(chatId) {
      const confirmed = window.confirm(
        '确定取消用户 ' + chatId + ' 的使用权限吗？\\n\\n' +
        '该操作不会删除用户已经上传的文件'
      );

      if (!confirmed) {
        return;
      }

      try {
        const response = await fetch('/api/users/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chat_id: chatId
          })
        });

        const data = await parseResponse(response);

        showMessage(
          data.message || '用户权限已删除',
          'success'
        );

        await loadUsers();
      } catch (error) {
        showMessage(
          '删除失败：' + error.message,
          'error'
        );
      }
    }

    addUserButton.addEventListener(
      'click',
      addUser
    );

    chatIdInput.addEventListener(
      'keydown',
      function(event) {
        if (event.key === 'Enter') {
          addUser();
        }
      }
    );

    refreshButton.addEventListener(
      'click',
      loadUsers
    );

    loadUsers();
  </script>
</body>
</html>`;
}
function generateAdminPage(fileCards, categoryOptions) {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <link rel="shortcut icon" href="https://tc-212.pages.dev/1744302340226.ico" type="image/x-icon">
    <meta name="description" content="Telegram文件存储与分享平台">
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>文件管理</title>
    <!-- 确保QR码库在页面加载前就可用 -->
    <script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
    <style>
      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        padding: 20px;
        min-height: 100vh;
        background: linear-gradient(135deg, #f0f4f8, #d9e2ec);
      }
      .container {
        max-width: 1200px;
        margin: 0 auto;
      }
      .header {
        background: rgba(255, 255, 255, 0.95);
        padding: 1.5rem;
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        margin-bottom: 1.5rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      h2 {
        color: #2c3e50;
        margin: 0;
        font-size: 1.8rem;
      }
      .right-content {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .search, .category-filter {
        padding: 0.7rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 0.9rem;
        background: #fff;
        transition: border-color 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.05);
      }
      .search:focus, .category-filter:focus {
        outline: none;
        border-color: #3498db;
      }
      .backup {
        color: #3498db;
        text-decoration: none;
        font-size: 1rem;
        transition: color 0.3s ease;
      }
      .backup:hover {
        color: #2980b9;
      }
      .return-btn {
        background: #2ecc71;
        color: white;
        padding: 0.7rem 1.5rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.3s ease;
        text-decoration: none;
        margin-left: 10px;
      }
      .return-btn:hover {
        background: #27ae60;
        transform: translateY(-2px);
      }
      .action-bar {
        background: rgba(255, 255, 255, 0.95);
        padding: 1.5rem;
        border-radius: 15px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        margin-bottom: 1.5rem;
        display: flex;
        gap: 1rem;
        align-items: center;
        justify-content: space-between;
      }
      .action-bar-left {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .action-bar-right {
        display: flex;
        gap: 1rem;
        align-items: center;
      }
      .action-bar h3 {
        margin: 0;
        color: #2c3e50;
        font-size: 1.2rem;
      }
      .action-bar select {
        padding: 0.7rem;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 0.9rem;
        background: #fff;
        transition: border-color 0.3s ease;
      }
      .action-bar select:focus {
        outline: none;
        border-color: #3498db;
      }
      .action-button {
        padding: 0.7rem 1.5rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
      }
      .select-all-btn {
        background: #3498db;
        color: white;
      }
      .delete-files-btn {
        background: #e74c3c;
        color: white;
      }
      .delete-category-btn {
        background: #e74c3c;
        color: white;
      }
      .action-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .select-all-btn:hover {
        background: #2980b9;
      }
      .delete-files-btn:hover {
        background: #c0392b;
      }
      .delete-category-btn:hover {
        background: #c0392b;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
        gap: 1.5rem;
      }
      .file-card {
        background: rgba(255, 255, 255, 0.95);
        border-radius: 15px;
        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        overflow: hidden;
        position: relative;
        transition: all 0.3s ease;
        cursor: pointer;
      }
      .file-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 8px 20px rgba(0,0,0,0.15);
      }
      .file-card.selected {
        border: 3px solid #3498db;
      }
      .file-checkbox {
        position: absolute;
        top: 10px;
        left: 10px;
        z-index: 5;
        width: 20px;
        height: 20px;
      }
      .file-preview {
        height: 150px;
        background: #f8f9fa;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .file-preview img, .file-preview video {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .file-info {
        padding: 1rem;
        font-size: 0.9rem;
        color: #2c3e50;
      }
      .file-actions {
        padding: 1rem;
        border-top: 1px solid #eee;
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .btn {
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
        display: inline-block;
        text-align: center;
      }
      .btn-share {
        background: #3498db;
        color: white;
        flex: 1;
      }
      .btn-down {
        background: #2ecc71;
        color: white;
        text-decoration: none;
        flex: 1;
      }
      .btn-delete {
        background: #e74c3c;
        color: white;
        flex: 1;
      }
      .btn-edit {
        background: #f39c12;
        color: white;
        flex: 1;
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .btn-share:hover {
        background: #2980b9;
      }
      .btn-down:hover {
        background: #27ae60;
      }
      .btn-delete:hover {
        background: #c0392b;
      }
      .btn-edit:hover {
        background: #e67e22;
      }
      .modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      .modal.show {
        display: flex;
        opacity: 1;
      }
      .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      .modal.show .modal-content {
        transform: scale(1);
      }
      .modal-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 1rem;
      }
      .modal-message {
        margin-bottom: 1.5rem;
        color: #34495e;
        line-height: 1.5;
      }
      .modal-buttons {
        display: flex;
        gap: 1rem;
        justify-content: center;
      }
      .modal-button {
        padding: 0.8rem 1.8rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.95rem;
        font-weight: 500;
      }
      .modal-confirm {
        background: #3498db;
        color: white;
      }
      .modal-cancel {
        background: #95a5a6;
        color: white;
      }
      .modal-button:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .modal-confirm:hover {
        background: #2980b9;
      }
      .modal-cancel:hover {
        background: #7f8c8d;
      }
      #qrModal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
      }
      #qrModal.show {
        display: flex;
        opacity: 1;
      }
      .qr-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 350px;
        transform: scale(0.9);
        transition: transform 0.3s ease;
      }
      #qrModal.show .qr-content {
        transform: scale(1);
      }
      .qr-title {
        color: #2c3e50;
        font-size: 1.3rem;
        margin-top: 0;
        margin-bottom: 0.5rem;
      }
      .qr-file-name {
        color: #7f8c8d;
        font-size: 0.9rem;
        margin-bottom: 1rem;
        word-break: break-all;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #qrcode {
        margin: 1.5rem auto;
      }
      .qr-buttons {
        display: flex;
        gap: 0.5rem;
        justify-content: center;
        margin-top: 1.5rem;
      }
      .qr-copy, .qr-download, .qr-close {
        padding: 0.8rem 1rem;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        font-size: 0.9rem;
        font-weight: 500;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .qr-copy {
        background: #3498db;
        color: white;
      }
      .qr-download {
        background: #2ecc71;
        color: white;
      }
      .qr-close {
        background: #95a5a6;
        color: white;
      }
      .qr-copy:hover, .qr-download:hover, .qr-close:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
      }
      .qr-copy:hover {
        background: #2980b9;
      }
      .qr-download:hover {
        background: #27ae60;
      }
      .qr-close:hover {
        background: #7f8c8d;
      }
      #editSuffixModal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        justify-content: center;
        align-items: center;
        z-index: 1000;
      }
      #editSuffixModal.show {
        display: flex;
      }
      #editSuffixModal .modal-content {
        background: white;
        padding: 2rem;
        border-radius: 15px;
        box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        text-align: center;
        width: 90%;
        max-width: 400px;
      }
      #editSuffixModal input {
        width: 100%;
        padding: 0.8rem;
        margin: 1rem 0;
        border: 2px solid #dfe6e9;
        border-radius: 8px;
        font-size: 1rem;
      }
      @media (max-width: 768px) {
        body {
          padding: 10px;
        }
        .container {
          padding: 1rem;
        }
        .header {
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
        }
        .header .right-content {
          flex-direction: column;
          width: 100%;
          gap: 10px;
          align-items: stretch;
        }
        .header input.search,
        .header select.category-filter,
        .header a.return-btn {
          width: 100%;
          box-sizing: border-box;
          margin-left: 0;
          text-align: center;
        }
        .action-bar {
          flex-direction: column;
          align-items: stretch;
          gap: 1rem;
        }
        .action-bar-left,
        .action-bar-right {
          flex-direction: column;
          align-items: stretch;
          gap: 10px;
          width: 100%;
        }
        .action-bar h3 {
          text-align: center;
        }
        .grid {
          grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
          gap: 1rem;
        }
        .file-card {
          border-radius: 10px;
        }
        .file-info {
           padding: 0.8rem;
           font-size: 0.85rem;
        }
        .file-actions {
           padding: 0.8rem;
           gap: 5px;
           flex-wrap: wrap;
        }
        .btn {
           padding: 0.6rem 0.8rem;
           font-size: 0.8rem;
           flex-grow: 1;
           min-width: 80px;
        }
      }
      @media (max-width: 480px) {
         .grid {
            grid-template-columns: 1fr;
         }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2>文件管理</h2>
        <div class="right-content">
          <input type="text" id="search-input" name="searchInput" class="search" placeholder="搜索文件名...">
          <select id="category-filter" name="categoryFilter" class="category-filter">
            <option value="">所有分类</option>
            ${categoryOptions}
          </select>

          <a
            href="/users"
            class="return-btn"
            style="background:#8e44ad;"
          >
            用户管理
          </a>

          <a href="/upload" class="return-btn">
            返回上传
          </a>
        </div>
      </div>
      <div class="action-bar">
        <div class="action-bar-left">
          <h3>文件操作：</h3>
          <button class="action-button select-all-btn" id="selectAllBtn">全选/取消</button>
          <button class="action-button delete-files-btn" id="deleteFilesBtn">删除选中</button>
        </div>
        <div class="action-bar-right">
          <h3>分类管理：</h3>
          <select id="categoryDeleteSelect" name="categoryDeleteSelect" class="category-filter">
            ${categoryOptions}
          </select>
          <button class="action-button delete-category-btn" id="deleteCategoryBtn">删除分类</button>
        </div>
      </div>
      <div class="grid" id="fileGrid">
        ${fileCards}
      </div>
      <!-- 确认删除弹窗 -->
      <div id="confirmModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">确认操作</h3>
          <p class="modal-message" id="confirmModalMessage"></p>
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="confirmModalConfirm">确认</button>
            <button class="modal-button modal-cancel" id="confirmModalCancel">取消</button>
          </div>
        </div>
      </div>
      <!-- 修改后缀弹窗 -->
      <div id="editSuffixModal" class="modal">
        <div class="modal-content">
          <h3 class="modal-title">修改文件后缀</h3>
          <input type="text" id="editSuffixInput" name="editSuffixInput" placeholder="输入新的文件后缀">
          <div class="modal-buttons">
            <button class="modal-button modal-confirm" id="editSuffixConfirm">确认</button>
            <button class="modal-button modal-cancel" id="editSuffixCancel">取消</button>
          </div>
        </div>
      </div>
    </div>
    <script>
      let currentShareUrl = '';
      let currentConfirmCallback = null;
      let currentEditUrl = '';
      let confirmModal, confirmModalMessage, confirmModalConfirm, confirmModalCancel, editSuffixModal, qrModal, qrCopyBtn, qrDownloadBtn, qrCloseBtn;
      async function setBingBackground() {
        try {
          const response = await fetch('/bing', { cache: 'no-store' });
          const data = await response.json();
          if (data.status && data.data && data.data.length > 0) {
            const randomIndex = Math.floor(Math.random() * data.data.length);
            document.body.style.backgroundImage = \`url(\${data.data[randomIndex].url})\`;
          }
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setTimeout(setBingBackground, 1000);
      document.addEventListener('DOMContentLoaded', function() {
        console.log('DOM已加载，初始化页面...');
        confirmModal = document.getElementById('confirmModal');
        confirmModalMessage = document.getElementById('confirmModalMessage');
        confirmModalConfirm = document.getElementById('confirmModalConfirm');
        confirmModalCancel = document.getElementById('confirmModalCancel');
        editSuffixModal = document.getElementById('editSuffixModal');
        qrModal = document.getElementById('qrModal');
        qrCopyBtn = document.getElementById('qrCopyBtn');
        qrDownloadBtn = document.getElementById('qrDownloadBtn');
        qrCloseBtn = document.getElementById('qrCloseBtn');
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const selectAllBtn = document.getElementById('selectAllBtn');
        const deleteFilesBtn = document.getElementById('deleteFilesBtn');
        const deleteCategoryBtn = document.getElementById('deleteCategoryBtn');
        const editSuffixConfirm = document.getElementById('editSuffixConfirm');
        const editSuffixCancel = document.getElementById('editSuffixCancel');
        console.log('页面元素引用:', {
          confirmModal: !!confirmModal,
          editSuffixModal: !!editSuffixModal,
          qrModal: !!qrModal
        });
        if (searchInput) searchInput.addEventListener('input', filterFiles);
        if (categoryFilter) categoryFilter.addEventListener('change', filterFiles);
        if (selectAllBtn) selectAllBtn.addEventListener('click', toggleSelectAll);
        if (deleteFilesBtn) deleteFilesBtn.addEventListener('click', confirmDeleteSelected);
        if (deleteCategoryBtn) deleteCategoryBtn.addEventListener('click', confirmDeleteCategory);
        if (confirmModalConfirm) confirmModalConfirm.addEventListener('click', handleConfirmModalConfirm);
        if (confirmModalCancel) confirmModalCancel.addEventListener('click', closeConfirmModal);
        if (editSuffixCancel) editSuffixCancel.addEventListener('click', function() {
          if (editSuffixModal) editSuffixModal.classList.remove('show');
        });
        if (editSuffixConfirm) editSuffixConfirm.addEventListener('click', updateFileSuffix);
        if (qrCopyBtn) qrCopyBtn.addEventListener('click', copyCurrentShareUrl);
        if (qrDownloadBtn) { }
        if (qrCloseBtn) qrCloseBtn.addEventListener('click', closeQrModal);
        window.addEventListener('click', handleWindowClick);
        initializeFileCards();
      });
      function initializeFileCards() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (!checkbox) return;
          card.addEventListener('click', (e) => {
            if (e.target === checkbox || 
                e.target.closest('.file-actions a') || 
                e.target.closest('.file-actions button')) {
              return; 
            }
            checkbox.checked = !checkbox.checked;
            const changeEvent = new Event('change', { bubbles: true });
            checkbox.dispatchEvent(changeEvent);
          });
          checkbox.addEventListener('change', () => {
            card.classList.toggle('selected', checkbox.checked);
          });
           card.classList.toggle('selected', checkbox.checked);
        });
      }
      function filterFiles() {
        const searchInput = document.getElementById('search-input');
        const categoryFilter = document.getElementById('category-filter');
        const fileGrid = document.getElementById('fileGrid');
        if (!searchInput || !categoryFilter || !fileGrid) return;
        const searchTerm = searchInput.value.toLowerCase();
        const selectedCategory = categoryFilter.value;
        const fileCards = Array.from(fileGrid.children);
        fileCards.forEach(card => {
          const fileInfo = card.querySelector('.file-info');
          if (!fileInfo) return;
          const fileName = fileInfo.querySelector('div:first-child')?.textContent.toLowerCase() || '';
          const categoryId = card.getAttribute('data-category-id') || '';
          const matchesSearch = fileName.includes(searchTerm);
          const matchesCategory = selectedCategory === '' || categoryId === selectedCategory;
          card.style.display = matchesSearch && matchesCategory ? '' : 'none';
        });
      }
      function toggleSelectAll() {
        const fileGrid = document.getElementById('fileGrid');
        if (!fileGrid) return;
        const fileCards = Array.from(fileGrid.children);
        const visibleCards = fileCards.filter(card => card.style.display !== 'none');
        const allSelected = visibleCards.every(card => card.querySelector('.file-checkbox')?.checked);
        visibleCards.forEach(card => {
          const checkbox = card.querySelector('.file-checkbox');
          if (checkbox) {
            checkbox.checked = !allSelected;
            card.classList.toggle('selected', !allSelected);
          }
        });
      }
      function confirmDeleteSelected() {
        const selectedCheckboxes = document.querySelectorAll('.file-checkbox:checked');
        if (selectedCheckboxes.length === 0) {
          showConfirmModal('请先选择要删除的文件！', null, true);
          return;
        }
        showConfirmModal(
          \`确定要删除选中的 \${selectedCheckboxes.length} 个文件吗？\`, 
          deleteSelectedFiles
        );
      }
      function confirmDeleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        if (!categoryId) {
          showConfirmModal('请选择要删除的分类', null, true);
          return;
        }
        const categoryName = select.options[select.selectedIndex].text;
        showConfirmModal(
          \`确定要删除分类 "\${categoryName}" 吗？这将清空所有关联文件的分类！\`, 
          deleteCategory
        );
      }
      function shareFile(url, fileName) {
        console.log('分享文件:', url);
        try {
          const modal = document.createElement('div');
          modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:1000;display:flex;justify-content:center;align-items:center;';
          const content = document.createElement('div');
          content.style.cssText = 'background:white;padding:20px;border-radius:10px;max-width:90%;width:350px;text-align:center;';
          const title = document.createElement('h3');
          title.style.cssText = 'margin-top:0;color:#333;';
          title.textContent = '分享文件';
          const fileNameElem = document.createElement('div');
          fileNameElem.style.cssText = 'margin-bottom:10px;word-break:break-all;font-size:14px;color:#666;';
          fileNameElem.textContent = fileName || getFileName(url);
          const qrContainer = document.createElement('div');
          qrContainer.id = 'qrcode-container';
          qrContainer.style.cssText = 'margin:20px auto;height:200px;width:200px;';
          try {
            const qrcode = new QRCode(qrContainer, {
              text: url,
              width: 200,
              height: 200,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H
            });
          } catch (qrError) {
            console.error('二维码生成失败:', qrError);
            qrContainer.innerHTML = '<div style="padding:20px;word-break:break-all;border:1px dashed #ccc;">' + url + '</div>';
          }
          const buttons = document.createElement('div');
          buttons.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:20px;';
          const copyBtn = document.createElement('button');
          copyBtn.id = 'copy-link-btn';
          copyBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#3498db;color:white;cursor:pointer;';
          copyBtn.textContent = '复制';
          copyBtn.onclick = function() {
            navigator.clipboard.writeText(url)
              .then(() => {
                copyBtn.textContent = '已复制';
                setTimeout(() => { copyBtn.textContent = '复制'; }, 2000);
              })
              .catch(() => {
                prompt('请手动复制链接:', url);
              });
          };
          const downloadBtn = document.createElement('a');
          downloadBtn.id = 'download-file-btn';
          downloadBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#2ecc71;color:white;cursor:pointer;text-decoration:none;display:inline-block;text-align:center;';
          downloadBtn.textContent = '下载';
          downloadBtn.href = url;
          downloadBtn.setAttribute('download', fileName || getFileName(url));
          const cancelBtn = document.createElement('button');
          cancelBtn.id = 'close-share-btn';
          cancelBtn.style.cssText = 'flex:1;padding:8px 15px;border:none;border-radius:4px;background:#95a5a6;color:white;cursor:pointer;';
          cancelBtn.textContent = '取消';
          cancelBtn.onclick = function() {
            document.body.removeChild(modal);
          };
          buttons.appendChild(copyBtn);
          buttons.appendChild(downloadBtn);
          buttons.appendChild(cancelBtn);
          content.appendChild(title);
          content.appendChild(fileNameElem);
          content.appendChild(qrContainer);
          content.appendChild(buttons);
          modal.appendChild(content);
          modal.addEventListener('click', function(e) {
            if (e.target === modal) {
              document.body.removeChild(modal);
            }
          });
          document.body.appendChild(modal);
        } catch (error) {
          console.error('分享功能出错:', error);
          try {
            navigator.clipboard.writeText(url)
              .then(() => alert('链接已复制: ' + url))
              .catch(() => prompt('请复制链接:', url));
          } catch (e) {
            prompt('请复制链接:', url);
          }
        }
      }
      function closeQrModal() {
        if (qrModal) qrModal.style.display = 'none';
      }
      function copyCurrentShareUrl() {
        if (!currentShareUrl) return;
        navigator.clipboard.writeText(currentShareUrl)
          .then(() => {
            if (qrCopyBtn) {
              qrCopyBtn.textContent = '✓ 已复制';
              setTimeout(() => {
                qrCopyBtn.textContent = '复制链接';
              }, 2000);
            }
          })
          .catch(() => {
            prompt('请手动复制链接:', currentShareUrl);
          });
      }
      function showConfirmModal(message, callback, alertOnly = false) {
        if (!confirmModal || !confirmModalMessage || !confirmModalConfirm || !confirmModalCancel) {
          alert(message);
          if (callback && !alertOnly) callback();
          return;
        }
        closeConfirmModal();
        confirmModalMessage.textContent = message;
        currentConfirmCallback = callback;
        if (alertOnly) {
          confirmModalConfirm.textContent = '确定';
          confirmModalCancel.style.display = 'none';
        } else {
          confirmModalConfirm.textContent = '确认';
          confirmModalCancel.style.display = 'inline-block';
        }
        confirmModal.classList.add('show');
      }
      function closeConfirmModal() {
        if (confirmModal) confirmModal.classList.remove('show');
      }
      function handleConfirmModalConfirm() {
        if (currentConfirmCallback) {
          currentConfirmCallback();
        }
        closeConfirmModal();
      }
      function handleWindowClick(event) {
        if (confirmModal && event.target === confirmModal) {
          closeConfirmModal();
        }
        if (qrModal && event.target === qrModal) { 
          closeQrModal();
        }
        if (editSuffixModal && event.target === editSuffixModal) {
          editSuffixModal.classList.remove('show');
        }
      }
      function showEditSuffixModal(url) {
        console.log('显示修改后缀弹窗:', url, '弹窗元素:', !!editSuffixModal);
        if (!editSuffixModal) {
          console.error('修改后缀弹窗元素不存在');
          alert('修改后缀功能不可用');
          return;
        }
        currentEditUrl = url;
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/');
        const fileName = pathParts[pathParts.length - 1];
        const fileNameParts = fileName.split('.');
        const extension = fileNameParts.pop(); 
        const currentSuffix = fileNameParts.join('.'); 
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (editSuffixInput) {
          editSuffixInput.value = currentSuffix;
          editSuffixModal.classList.add('show');
        } else {
          console.error('找不到编辑后缀输入框');
        }
      }
      async function deleteFile(url, card) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          const fileName = pathParts[pathParts.length - 1];
          const response = await fetch('/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: url, fileId: fileName }) 
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || errorData.message || '删除失败');
          }
          if (card) {
            card.remove();
          } else {
            const card = document.querySelector(\`[data-url="\${url}"]\`);
            if (card) card.remove();
          }
          showConfirmModal('文件删除成功', null, true);
        } catch (error) {
          showConfirmModal('文件删除失败: ' + error.message, null, true);
        }
      }
      async function deleteSelectedFiles() {
        const checkboxes = document.querySelectorAll('.file-checkbox:checked');
        const urls = Array.from(checkboxes).map(cb => cb.value);
        try {
          const response = await fetch('/delete-multiple', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls })
          });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '批量删除失败');
          }
          checkboxes.forEach(cb => {
            const card = cb.closest('.file-card');
            if (card) card.remove();
          });
          showConfirmModal('批量删除成功', null, true);
        } catch (error) {
          showConfirmModal('批量删除失败: ' + error.message, null, true);
        }
      }
      async function deleteCategory() {
        const select = document.getElementById('categoryDeleteSelect');
        if (!select) return;
        const categoryId = select.value;
        try {
          const response = await fetch('/delete-category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: categoryId })
          });
          const data = await response.json();
          if (data.status === 1) {
            select.remove(select.selectedIndex);
            showConfirmModal(data.msg, () => {
              window.location.reload();
            }, true);
          } else {
            showConfirmModal(data.msg, null, true);
          }
        } catch (error) {
          showConfirmModal('删除分类失败: ' + error.message, null, true);
        }
      }
      async function updateFileSuffix() {
        const editSuffixInput = document.getElementById('editSuffixInput');
        if (!editSuffixInput) return;
        const newSuffix = editSuffixInput.value;
        try {
          const response = await fetch('/update-suffix', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              url: currentEditUrl,
              suffix: newSuffix
            })
          });
          const data = await response.json();
          if (data.status === 1) {
            if (editSuffixModal) editSuffixModal.classList.remove('show');
            const card = document.querySelector('.file-card[data-url="' + currentEditUrl + '"]');
            if (card) {
              card.setAttribute('data-url', data.newUrl);
              const shareBtn = card.querySelector('.btn-share');
              const deleteBtn = card.querySelector('.btn-delete');
              const editBtn = card.querySelector('.btn-edit');
              if (shareBtn) {
                const fileName = data.fileName || getFileName(data.newUrl);
                shareBtn.setAttribute('onclick', 'shareFile("' + data.newUrl + '", "' + fileName + '")');
              }
              if (deleteBtn) {
                const newOnclick = deleteBtn.getAttribute('onclick').replace(currentEditUrl, data.newUrl);
                deleteBtn.setAttribute('onclick', newOnclick);
              }
              if (editBtn) {
                editBtn.setAttribute('onclick', 'showEditSuffixModal("' + data.newUrl + '")');
              }
              const fileNameElement = card.querySelector('.file-info div:first-child');
              if (fileNameElement) {
                let fileName = data.fileName;
                if (!fileName) {
                  const urlObj = new URL(data.newUrl);
                  fileName = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
                }
                fileNameElement.textContent = fileName;
              }
              const checkbox = card.querySelector('.file-checkbox');
              if (checkbox) {
                checkbox.value = data.newUrl;
              }
            }
            currentEditUrl = data.newUrl;
            showConfirmModal(data.msg, null, true);
          } else {
            showConfirmModal(data.msg || '修改后缀失败', null, true);
          }
        } catch (error) {
          showConfirmModal('修改后缀时出错：' + error.message, null, true);
        }
      }
      function getFileName(url) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/');
          return pathParts[pathParts.length - 1];
        } catch (e) {
          return url.split('/').pop() || url;
        }
      }
    </script>
  </body>
  </html>`;
}
async function handleUpdateSuffixRequest(request, config) {
  try {
    const { url, suffix, id } = await request.json();
    if ((!url && !id) || !String(suffix || '').trim()) {
      return new Response(JSON.stringify({
        status: 0,
        msg: '文件标识和新文件名不能为空'
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    let fileRecord = null;
    if (id) {
      fileRecord = await config.database.prepare(
        'SELECT * FROM files WHERE id = ?'
      ).bind(id).first();
    }
    if (!fileRecord && url) {
      fileRecord = await config.database.prepare(
        'SELECT * FROM files WHERE url = ?'
      ).bind(url).first();
    }
    if (!fileRecord && url) {
      const path = (() => {
        try { return decodeURIComponent(new URL(url).pathname.split('/').pop()); }
        catch (_) { return String(url).split('/').pop(); }
      })();
      fileRecord = await config.database.prepare(`
        SELECT * FROM files
        WHERE fileId = ? OR file_name = ?
        ORDER BY id DESC LIMIT 1
      `).bind(path, path).first();
    }
    if (!fileRecord) {
      return new Response(JSON.stringify({
        status: 0,
        msg: '未找到对应的文件记录'
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const renamed = await renameStoredFileRecord(fileRecord, suffix, config);
    return new Response(JSON.stringify({
      status: 1,
      msg: renamed.isChunked
        ? `文件名修改成功；${renamed.chunkCount} 个分片无需重新上传`
        : '文件名修改成功',
      newUrl: renamed.url,
      fileName: renamed.fileName,
      isChunked: renamed.isChunked,
      chunkCount: renamed.chunkCount
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('更新文件名失败:', error);
    return new Response(JSON.stringify({
      status: 0,
      msg: '更新文件名失败: ' + error.message
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
}
function generateNewUrl(url, suffix, config) {
  const fileName = getFileName(url);
  const newFileName = suffix + '.' + fileName.split('.').pop();
  return `https://${config.domain}/${newFileName}`;
}
function getFileName(url) {
  try {
    const urlObj = new URL(String(url || ''));
    const pathParts = urlObj.pathname.split('/');
    return decodeURIComponent(pathParts[pathParts.length - 1] || '');
  } catch (_) {
    return String(url || '').split('/').pop() || '';
  }
}
function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => {
      showConfirmModal('已复制到剪贴板', null, true);
    })
    .catch(() => {
      showConfirmModal('复制失败，请手动复制', null, true);
    });
}
function getExtensionFromMime(mimeType) {
  if (!mimeType) return 'jpg';
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/x-msvideo': 'avi',
    'video/quicktime': 'mov',
    'video/x-ms-wmv': 'wmv',
    'video/x-flv': 'flv',
    'video/x-matroska': 'mkv',
    'video/x-m4v': 'm4v',
    'video/mp2t': 'ts',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'audio/x-ms-wma': 'wma',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/rtf': 'rtf',
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/gzip': 'gz',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
    'application/json': 'json',
    'application/xml': 'xml',
    'font/ttf': 'ttf',
    'font/otf': 'otf',
    'font/woff': 'woff',
    'font/woff2': 'woff2',
    'application/vnd.ms-fontobject': 'eot',
    'application/octet-stream': 'bin',
    'application/x-shockwave-flash': 'swf'
  };
  return mimeMap[mimeType] || 'bin';
}
async function uploadToR2(arrayBuffer, fileName, mimeType, config) {
  try {
    return await storeFile(arrayBuffer, fileName, mimeType, config);
  } catch (error) {
    console.error('上传到R2失败:', error);
    throw new Error(`上传到存储服务失败: ${error.message}`);
  }
}
async function storeFile(arrayBuffer, fileName, mimeType, config) {
  if (config.bucket) {
    try {
      await config.bucket.put(fileName, arrayBuffer, {
        httpMetadata: { contentType: mimeType || 'application/octet-stream' }
      });
      return `https://${config.domain}/${fileName}`;
    } catch (error) {
      console.error(`R2存储失败: ${error.message}`);
      return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
    }
  } else {
    return await storeFileInTelegram(arrayBuffer, fileName, mimeType, config);
  }
}
async function storeFileInTelegram(arrayBuffer, fileName, mimeType, config) {
  if (!config.tgBotToken || !config.tgStorageChatId) {
    throw new Error('未配置Telegram存储参数 (TG_BOT_TOKEN 和 TG_STORAGE_CHAT_ID)');
  }
  const formData = new FormData();
  const blob = new Blob([arrayBuffer], { type: mimeType || 'application/octet-stream' });
  formData.append('document', blob, fileName);
  const response = await fetch(`${telegramMethodUrl(config.tgBotToken, 'sendDocument', config)}?chat_id=${encodeURIComponent(config.tgStorageChatId)}`, {
    method: 'POST',
    body: formData
  });
  const result = await response.json();
  if (result.ok) {
    const fileId = result.result.document.file_id;
    const fileUrl = await getTelegramFileUrl(fileId, config.tgBotToken, config);
    return fileUrl;
  } else {
    throw new Error('Telegram存储失败: ' + JSON.stringify(result));
  }
}
async function getFile(fileId, config) {
  if (config.bucket) {
    try {
      return await config.bucket.get(fileId);
    } catch (error) {
      console.error('R2获取文件失败:', error);
      return null;
    }
  }
  return null;
}
async function deleteFile(fileId, config) {
  if (config.bucket) {
    try {
      await config.bucket.delete(fileId);
      return true;
    } catch (error) {
      console.error('R2删除文件失败:', error);
      return false;
    }
  }
  return true; 
}
async function fetchNotification() {
    return '';
}
function copyShareUrl(url, fileName) {
  console.log('复制分享链接:', url);
  try {
    navigator.clipboard.writeText(url)
      .then(() => {
        alert('链接已复制到剪贴板: ' + url);
      })
      .catch((err) => {
        console.error('复制失败:', err);
        prompt('请手动复制以下链接:', url);
      });
  } catch (error) {
    console.error('复制出错:', error);
    prompt('请手动复制以下链接:', url);
  }
}
try {
  document.addEventListener('DOMContentLoaded', function() {
    try {
      console.log('DOM加载完成，初始化页面元素引用');
      window.editSuffixModal = document.getElementById('editSuffixModal');
      if (window.editSuffixModal) {
        console.log('成功获取修改后缀弹窗元素');
      } else {
        console.error('无法获取修改后缀弹窗元素');
      }
      window.currentEditUrl = '';
      window.shareFile = shareFile;
      window.showConfirmModal = showConfirmModal;
      window.showEditSuffixModal = showEditSuffixModal;
      window.deleteFile = deleteFile;
      window.handleConfirmModalConfirm = handleConfirmModalConfirm;
      window.closeConfirmModal = closeConfirmModal;
      window.confirmModal = document.getElementById('confirmModal');
      window.confirmModalMessage = document.getElementById('confirmModalMessage');
      window.confirmModalConfirm = document.getElementById('confirmModalConfirm');
      window.confirmModalCancel = document.getElementById('confirmModalCancel');
    } catch (error) {
      console.error('初始化页面元素引用时出错:', error);
    }
  });
} catch (error) {
  console.error('添加DOMContentLoaded事件监听器失败:', error);
}
