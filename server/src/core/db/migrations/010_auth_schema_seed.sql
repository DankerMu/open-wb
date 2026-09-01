-- 首个业务 schema：账号表与认证会话表。同名冲突必须使本迁移事务失败，
-- 不得静默接受未知状态。auth_sessions 是登录会话，不是未来的 Agent 对话状态。
-- password_hash 自描述编码：scrypt$N$r$p$<32 lowercase hex salt>$<64 lowercase hex digest>。

CREATE TABLE accounts (
  id TEXT NOT NULL,
  account TEXT NOT NULL,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL,
  password_hash TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (account),
  CHECK (typeof(id) = 'text' AND length(id) > 0),
  CHECK (account = lower(trim(account)) AND length(account) > 0),
  CHECK (role IN ('成员', '管理员')),
  CHECK (typeof(disabled) = 'integer' AND disabled IN (0, 1)),
  CHECK (
    typeof(password_hash) = 'text'
    AND length(password_hash) = 114
    AND substr(password_hash, 1, 17) = 'scrypt$16384$8$1$'
    AND substr(password_hash, 50, 1) = '$'
    AND substr(password_hash, 18, 32) NOT GLOB '*[^0-9a-f]*'
    AND substr(password_hash, 51, 64) NOT GLOB '*[^0-9a-f]*'
  )
);

INSERT INTO accounts(id, account, role, disabled, password_hash) VALUES
  (
    'u1',
    'zhangsan',
    '成员',
    0,
    'scrypt$16384$8$1$b597609e46e3097e0b96fa7204254a63$4cccb4d61b561586fbc223f086dfe899ef43771b43864b0632e8a7e66a5046b8'
  ),
  (
    'u2',
    'zhaoliu',
    '成员',
    0,
    'scrypt$16384$8$1$72ed1a36dae3cabc782692ec2b8fd8ce$d37a793e965e2ec6951bb2caf6a576495510eeeb0d14721733b92f03e561d727'
  ),
  (
    'u3',
    'lisi',
    '管理员',
    0,
    'scrypt$16384$8$1$49ac2b279fe868c22f01f37d1d6e5274$0b527353e30dca2c1d4686d1ee6c56656e861df3adacb8ef47e1a62c6e7a83f5'
  ),
  (
    'u4',
    'wangwu',
    '成员',
    1,
    'scrypt$16384$8$1$4d5d6df1929d31c840f95df5862a9657$824f0939d20d3d8383e3235abac1f433f0028bf8ef6de5f2e4bead66d3878970'
  );

CREATE TABLE auth_sessions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CHECK (typeof(id) = 'text' AND length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  CHECK (typeof(expires_at) = 'integer' AND expires_at >= 0)
);
