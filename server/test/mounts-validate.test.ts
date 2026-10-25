/**
 * s1b-workspace-mounts group 1 (validate part): the mount and mount-source POST body rules (design D1
 * `name` rule, D2; workspace-mounts「挂载取值与主机规则」key sets and values,「挂载源端点」body shape).
 * Expected outcomes are the spec's literals; credentials are sentinels and no refusal may carry a
 * submitted value — every refusal is asserted to name its field and to lack that case's sentinel.
 */
import { describe, expect, it } from "vitest";
import {
  type MountBody,
  type MountSourceBody,
  type ValidationResult,
  validateMountBody,
  validateMountSourceBody,
} from "../src/workspaces/mounts/validate.js";

const SENTINEL = "Snt1nelQ7x";
const KEY_PREFIX = "-----BEGIN TEST FIXTURE-----\n";
const KEY = `${KEY_PREFIX}${SENTINEL}\n-----END TEST FIXTURE-----\n`;
const SOURCE_ID = "0123456789abcdef0123456789abcdef";

function sftpPassword(): Record<string, unknown> {
  return {
    name: "remote",
    backend: "sftp",
    host: "files.intra",
    port: 22,
    remotePath: "/srv/data",
    readOnly: false,
    username: "alice",
    password: `pw-${SENTINEL}`,
  };
}

function sftpKey(): Record<string, unknown> {
  const { password: _password, ...rest } = sftpPassword();
  return { ...rest, privateKey: KEY };
}

function smb(): Record<string, unknown> {
  return {
    name: "共享",
    backend: "smb",
    host: "10.0.0.5",
    remotePath: "/share/dir",
    readOnly: true,
    username: "bob",
    password: `pw-${SENTINEL}`,
    domain: "CORP",
  };
}

function local(): Record<string, unknown> {
  return { name: "数据仓库导出", backend: "local", sourceId: SOURCE_ID, readOnly: true };
}

function source(): Record<string, unknown> {
  return { name: "NFS 共享", path: "/srv/nfs", readOnly: true };
}

/** A refusal naming `field`, with neither the sentinel nor any of `absent` anywhere in the result. */
function expectRejected<T>(result: ValidationResult<T>, field: string, ...absent: string[]): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.field).toBe(field);
  expect(result.message).toContain(field);
  const text = JSON.stringify(result);
  for (const value of [SENTINEL, ...absent]) {
    expect(text).not.toContain(value);
  }
}

function expectAccepted<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`unexpected refusal of ${result.field}`);
  }
  return result.value;
}

describe("validateMountBody: one valid body per backend", () => {
  it("accepts sftp with a password and returns its typed values", () => {
    const value: MountBody = expectAccepted(validateMountBody(sftpPassword()));
    expect(value).toEqual(sftpPassword());
  });

  it("accepts sftp with a private key and no port", () => {
    const { port: _port, ...body } = sftpKey();
    const value = expectAccepted(validateMountBody(body));
    expect(value).toEqual(body);
    expect(Object.hasOwn(value, "port")).toBe(false);
  });

  it("accepts smb with a domain and without one", () => {
    expect(expectAccepted(validateMountBody(smb()))).toEqual(smb());
    const { domain: _domain, ...body } = smb();
    expect(expectAccepted(validateMountBody(body))).toEqual(body);
  });

  it("accepts local with the CJK name the design calls legal", () => {
    expect(expectAccepted(validateMountBody(local()))).toEqual(local());
  });

  it("returns a fresh object, not the submitted one", () => {
    const body = sftpPassword();
    expect(expectAccepted(validateMountBody(body))).not.toBe(body);
  });
});

describe("validateMountBody: strict key sets per backend", () => {
  it("refuses sftp with both password and privateKey", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), privateKey: KEY }), "password");
  });

  it("refuses sftp with neither password nor privateKey", () => {
    const { password: _password, ...body } = sftpPassword();
    expectRejected(validateMountBody({ ...body, username: `u-${SENTINEL}` }), "password");
  });

  it("refuses smb carrying privateKey", () => {
    expectRejected(validateMountBody({ ...smb(), privateKey: KEY }), "body");
  });

  it("refuses smb without password", () => {
    const { password: _password, ...body } = smb();
    expectRejected(validateMountBody({ ...body, username: `u-${SENTINEL}` }), "password");
  });

  it("refuses local carrying host", () => {
    expectRejected(validateMountBody({ ...local(), host: `${SENTINEL}.intra` }), "body");
  });

  it("refuses local carrying credentials", () => {
    expectRejected(validateMountBody({ ...local(), password: `pw-${SENTINEL}` }), "body");
  });

  it("refuses an unknown key without echoing the key name", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), [SENTINEL]: 1 }), "body");
  });

  it("refuses each missing required key, naming it", () => {
    for (const key of ["name", "host", "remotePath", "readOnly", "username"]) {
      const body = sftpPassword();
      delete body[key];
      expectRejected(validateMountBody(body), key);
    }
    for (const key of ["name", "sourceId", "readOnly"]) {
      const body = local();
      delete body[key];
      expectRejected(validateMountBody({ ...body }), key);
    }
  });

  it("refuses an unknown or missing backend, naming backend", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), backend: "nfs" }), "backend");
    const { backend: _backend, ...body } = sftpPassword();
    expectRejected(validateMountBody(body), "backend");
  });

  it("refuses a non-object body", () => {
    for (const body of [null, [sftpPassword()], `pw-${SENTINEL}`, 42, undefined]) {
      expectRejected(validateMountBody(body), "body");
    }
  });

  it("refuses null for an optional key (type mismatch)", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), port: null }), "port");
    expectRejected(validateMountBody({ ...smb(), domain: null }), "domain");
  });
});

describe("validateMountBody: name", () => {
  it("refuses the reserved names uploads and screenshots", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), name: "uploads" }), "name", "uploads");
    expectRejected(
      validateMountBody({ ...sftpPassword(), name: "screenshots" }),
      "name",
      "screenshots",
    );
  });

  it("refuses characters outside the workspaces dir alphabet", () => {
    for (const name of ["a.b", ".", "..", "a/b", "a b", "", "é", "ａ"]) {
      expectRejected(validateMountBody({ ...sftpPassword(), name }), "name");
    }
  });

  it("refuses 65 characters and accepts 64, CJK counted as characters", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), name: "a".repeat(65) }), "name");
    expectRejected(validateMountBody({ ...sftpPassword(), name: "数".repeat(65) }), "name");
    expectAccepted(validateMountBody({ ...sftpPassword(), name: "a".repeat(64) }));
    expectAccepted(validateMountBody({ ...sftpPassword(), name: "数".repeat(64) }));
  });

  it("accepts the alphabet's edges", () => {
    for (const name of ["A-z_09", "一", "龥", "-", "_", "Uploads"]) {
      expectAccepted(validateMountBody({ ...sftpPassword(), name }));
    }
    expectRejected(validateMountBody({ ...sftpPassword(), name: "龦" }), "name");
  });
});

describe("validateMountBody: readOnly", () => {
  it("refuses a non-boolean", () => {
    for (const readOnly of ["true", 1, 0, null]) {
      expectRejected(validateMountBody({ ...local(), readOnly }), "readOnly");
    }
  });
});

describe("validateMountBody: host", () => {
  it("refuses a leading -, a /, and 254 bytes; accepts 253 bytes", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), host: "-files.intra" }), "host");
    expectRejected(validateMountBody({ ...sftpPassword(), host: "files.intra/x" }), "host");
    expectRejected(validateMountBody({ ...sftpPassword(), host: "a".repeat(254) }), "host");
    expectAccepted(validateMountBody({ ...sftpPassword(), host: "a".repeat(253) }));
  });

  it("refuses the empty host and characters outside [A-Za-z0-9.:-]", () => {
    for (const host of ["", "a_b", "a b", "例子.intra", "a@b", "[::1]"]) {
      expectRejected(validateMountBody({ ...sftpPassword(), host }), "host");
    }
  });

  it("accepts IPv4 and IPv6 literals and an inner -", () => {
    for (const host of ["10.0.0.5", "fe80::1", "files-1.intra.", ".a", ":"]) {
      expectAccepted(validateMountBody({ ...sftpPassword(), host }));
    }
  });

  it("refuses a non-string host", () => {
    expectRejected(validateMountBody({ ...smb(), host: 10 }), "host");
  });
});

describe("validateMountBody: port", () => {
  it("refuses 0, 65536, a non-integer and the string 22", () => {
    for (const port of [0, 65536, -1, 22.5, "22", Number.NaN]) {
      expectRejected(validateMountBody({ ...sftpPassword(), port }), "port");
    }
  });

  it("accepts 1 and 65535", () => {
    expectAccepted(validateMountBody({ ...sftpPassword(), port: 1 }));
    expectAccepted(validateMountBody({ ...smb(), port: 65535 }));
  });
});

describe("validateMountBody: remotePath", () => {
  it("refuses a relative path", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), remotePath: "srv/data" }), "remotePath");
  });

  it("refuses smb's / and an empty share segment, accepts sftp's /", () => {
    expectRejected(validateMountBody({ ...smb(), remotePath: "/" }), "remotePath");
    expectRejected(validateMountBody({ ...smb(), remotePath: "//share" }), "remotePath");
    expectAccepted(validateMountBody({ ...smb(), remotePath: "/share" }));
    expectAccepted(validateMountBody({ ...sftpPassword(), remotePath: "/" }));
  });

  it("refuses control characters", () => {
    for (const remotePath of ["/srv/\u0000", "/srv/\n", "/srv/\u001f", "/srv/\u007f"]) {
      expectRejected(validateMountBody({ ...sftpPassword(), remotePath }), "remotePath");
    }
  });

  it("counts UTF-8 bytes: 1024 accepted, 1025 refused", () => {
    // "/" + 341 three-byte characters = 1024 bytes.
    expectAccepted(validateMountBody({ ...sftpPassword(), remotePath: `/${"数".repeat(341)}` }));
    expectRejected(
      validateMountBody({ ...sftpPassword(), remotePath: `/${"数".repeat(341)}a` }),
      "remotePath",
    );
  });
});

describe("validateMountBody: username, password, domain", () => {
  it("refuses a password with a newline carrying the sentinel", () => {
    expectRejected(
      validateMountBody({ ...sftpPassword(), password: `a\n${SENTINEL}` }),
      "password",
    );
    expectRejected(validateMountBody({ ...smb(), password: `${SENTINEL}\r` }), "password");
  });

  it("refuses username with leading or trailing whitespace", () => {
    for (const username of [` ${SENTINEL}`, `${SENTINEL} `, `　${SENTINEL}`]) {
      expectRejected(validateMountBody({ ...sftpPassword(), username }), "username");
    }
  });

  it("refuses password with leading or trailing whitespace and the empty password", () => {
    for (const password of [` ${SENTINEL}`, `${SENTINEL} `, ""]) {
      expectRejected(validateMountBody({ ...smb(), password }), "password");
    }
  });

  it("refuses domain with a space and outside [A-Za-z0-9._-]", () => {
    for (const domain of [`CO ${SENTINEL}`, `${SENTINEL}/x`, "", "域"]) {
      expectRejected(validateMountBody({ ...smb(), domain }), "domain");
    }
    expectAccepted(validateMountBody({ ...smb(), domain: "corp.example_1-a" }));
  });

  it("counts username and password in characters", () => {
    expectAccepted(validateMountBody({ ...sftpPassword(), username: "名".repeat(256) }));
    expectRejected(
      validateMountBody({ ...sftpPassword(), username: "名".repeat(257) }),
      "username",
    );
    expectAccepted(validateMountBody({ ...sftpPassword(), password: "密".repeat(1024) }));
    expectRejected(
      validateMountBody({ ...sftpPassword(), password: `${SENTINEL}${"密".repeat(1015)}` }),
      "password",
    );
    expectRejected(validateMountBody({ ...sftpPassword(), username: "" }), "username");
  });

  it("counts domain in bytes: 64 accepted, 65 refused", () => {
    expectAccepted(validateMountBody({ ...smb(), domain: "d".repeat(64) }));
    expectRejected(
      validateMountBody({ ...smb(), domain: `${SENTINEL}${"d".repeat(55)}` }),
      "domain",
    );
  });

  it("refuses control characters in username and domain", () => {
    expectRejected(validateMountBody({ ...smb(), username: `a\u0007${SENTINEL}` }), "username");
    expectRejected(validateMountBody({ ...smb(), username: `a\u007f${SENTINEL}` }), "username");
    expectRejected(validateMountBody({ ...smb(), domain: `a\t${SENTINEL}` }), "domain");
  });

  it("refuses non-string credentials", () => {
    expectRejected(validateMountBody({ ...sftpPassword(), password: 1 }), "password");
    expectRejected(validateMountBody({ ...sftpPassword(), username: [SENTINEL] }), "username");
  });
});

describe("validateMountBody: privateKey", () => {
  function sized(bytes: number): string {
    return `${KEY_PREFIX}${SENTINEL}${"A".repeat(bytes - KEY_PREFIX.length - SENTINEL.length)}`;
  }

  it("refuses 16385 bytes and accepts 16384", () => {
    expect(Buffer.byteLength(sized(16385))).toBe(16385);
    expectRejected(validateMountBody({ ...sftpKey(), privateKey: sized(16385) }), "privateKey");
    expectAccepted(validateMountBody({ ...sftpKey(), privateKey: sized(16384) }));
  });

  it("refuses a key not starting with -----BEGIN followed by a space", () => {
    for (const privateKey of [`${SENTINEL}\n${KEY}`, `-----BEGIN${SENTINEL}`, ` ${KEY}`, ""]) {
      expectRejected(validateMountBody({ ...sftpKey(), privateKey }), "privateKey");
    }
  });

  it("refuses anything but printable ASCII and newline", () => {
    for (const extra of ["\r", "\t", "\u0000", "\u007f", "é"]) {
      expectRejected(
        validateMountBody({ ...sftpKey(), privateKey: `${KEY}${extra}` }),
        "privateKey",
      );
    }
  });
});

describe("validateMountBody: sourceId", () => {
  it("refuses anything but 32 lowercase hex", () => {
    for (const sourceId of [
      SOURCE_ID.toUpperCase(),
      SOURCE_ID.slice(1),
      `${SOURCE_ID}0`,
      `${SOURCE_ID.slice(1)}g`,
      `${SENTINEL}${SOURCE_ID.slice(SENTINEL.length)}`,
      1,
    ]) {
      expectRejected(validateMountBody({ ...local(), sourceId }), "sourceId");
    }
  });
});

describe("validateMountSourceBody", () => {
  it("accepts {name, path, readOnly} and returns its typed values", () => {
    const value: MountSourceBody = expectAccepted(validateMountSourceBody(source()));
    expect(value).toEqual(source());
    expectAccepted(
      validateMountSourceBody({ ...source(), name: "源".repeat(64), readOnly: false }),
    );
  });

  it("refuses the empty name, 65 characters and U+0007", () => {
    expectRejected(validateMountSourceBody({ ...source(), name: "" }), "name");
    expectRejected(
      validateMountSourceBody({ ...source(), name: `${SENTINEL}${"源".repeat(55)}` }),
      "name",
    );
    expectRejected(validateMountSourceBody({ ...source(), name: `a\u0007${SENTINEL}` }), "name");
    expectRejected(validateMountSourceBody({ ...source(), name: `a\u007f${SENTINEL}` }), "name");
  });

  it("refuses a relative path", () => {
    for (const path of [`srv/${SENTINEL}`, `./${SENTINEL}`, "", 1]) {
      expectRejected(validateMountSourceBody({ ...source(), path }), "path");
    }
  });

  it("refuses a non-boolean readOnly", () => {
    expectRejected(validateMountSourceBody({ ...source(), readOnly: "false" }), "readOnly");
  });

  it("refuses an extra key, a missing key and a non-object body", () => {
    expectRejected(validateMountSourceBody({ ...source(), [SENTINEL]: true }), "body");
    expectRejected(validateMountSourceBody({ ...source(), id: SOURCE_ID }), "body");
    const { readOnly: _readOnly, ...body } = source();
    expectRejected(validateMountSourceBody(body), "readOnly");
    for (const value of [null, [], SENTINEL]) {
      expectRejected(validateMountSourceBody(value), "body");
    }
  });
});
