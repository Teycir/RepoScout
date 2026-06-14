// src/lib/validator.ts
// Port of secretscout-core/src/validator.rs
// External API credential checks for 30+ providers.

export type ValidationStatus =
  | "ACTIVE"
  | "REVOKED"
  | "UNVERIFIABLE"
  | "FALSE_POSITIVE";

export interface ValidationResult {
  status: ValidationStatus;
  message: string;
  checkedAt: string;
}

const FETCH_TIMEOUT_MS = 10000; // 10 seconds

async function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    } as any);
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Pattern ID → validator dispatch
// ---------------------------------------------------------------------------

/**
 * Attempt to validate a credential against its provider's API.
 * Returns UNVERIFIABLE for unknown patterns or network errors.
 */
export async function validateCredential(
  patternId: string,
  token: string,
): Promise<ValidationResult> {
  const now = new Date().toISOString();
  const id = patternId.toLowerCase();

  try {
    if (id.includes("github")) return await validateGitHub(token, now);
    if (id.includes("gitlab")) return await validateGitLab(token, now);
    if (id.includes("stripe")) return await validateStripe(token, now);
    if (id.includes("slack")) return await validateSlack(token, now);
    if (id.includes("anthropic") || id.includes("claude"))
      return await validateAnthropic(token, now);
    if (id.includes("openai")) return await validateOpenAI(token, now);
    if (id.includes("huggingface") || id.includes("hf-"))
      return await validateHuggingFace(token, now);
    if (id.includes("sendgrid")) return await validateSendGrid(token, now);
    if (id.includes("twilio")) return await validateTwilio(token, now);
    if (id.includes("shopify")) return await validateShopify(token, now);
    if (id.includes("aws") || id.includes("amazon"))
      return await validateAWS(token, now);
    if (id.includes("digitalocean"))
      return await validateDigitalOcean(token, now);
    if (id.includes("mailchimp")) return await validateMailchimp(token, now);
    if (id.includes("braintree")) return await validateBraintree(token, now);
    if (id.includes("square")) return await validateSquare(token, now);
    if (id.includes("datadog")) return await validateDatadog(token, now);
    if (id.includes("newrelic")) return await validateNewRelic(token, now);
    if (id.includes("npm")) return await validateNpm(token, now);
    if (id.includes("pypi")) return await validatePyPI(token, now);
    if (id.includes("dockerhub") || id.includes("docker-hub"))
      return await validateDockerHub(token, now);
    if (id.includes("google-api-key") || id.includes("gcp-api-key"))
      return await validateGoogleApiKey(token, now);
    if (id.includes("firebase")) {
      const cleanToken = token.split("|")[0]!;
      if (cleanToken.startsWith("AIzaSy")) {
        return await validateGoogleApiKey(token, now);
      }
      return await validateFirebase(token, now);
    }
    if (id.includes("jwt-token")) {
      const cleanToken = token.split("|")[0]!;
      const payload = decodeJwt(cleanToken);
      if (payload && (payload.iss === "supabase" || payload.ref)) {
        return await validateSupabaseKey(token, now);
      }
    }
    if (id.includes("algolia")) return await validateAlgolia(token, now);
    if (id.includes("okta")) return await validateOkta(token, now);

    if (id.includes("heroku")) return await validateHeroku(token, now);
    if (id.includes("netlify")) return await validateNetlify(token, now);
    if (id.includes("vercel")) return await validateVercel(token, now);
    if (id.includes("linear")) return await validateLinear(token, now);
    if (id.includes("notion")) return await validateNotion(token, now);
    if (id.includes("discord")) return await validateDiscord(token, now);
    if (id.includes("telegram")) return await validateTelegram(token, now);
    // Newly ported providers
    if (id.includes("dropbox")) return await validateDropbox(token, now);
    if (id.includes("twitch")) return await validateTwitch(token, now);
    if (id.includes("zoom")) return await validateZoom(token, now);
    if (id.includes("asana")) return await validateAsana(token, now);
    if (id.includes("mailgun")) return await validateMailgun(token, now);
    if (id.includes("sentry")) return await validateSentry(token, now);
    if (id.includes("airtable")) return await validateAirtable(token, now);
    if (id.includes("paypal")) return await validatePayPal(token, now);
    // RSA / private-key proof-of-possession
    if (id.includes("private-key") || id.includes("rsa") || id.includes("pem"))
      return await validatePrivateKey(token, now);
  } catch (e) {
    console.warn(`[validator] ${patternId} check threw:`, e);
  }

  return {
    status: "UNVERIFIABLE",
    message: `No validator for pattern: ${patternId}`,
    checkedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function validateGitHub(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "RepoScout-Validator/1.0",
    },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "GitHub PAT verified via /user",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "GitHub PAT returned 401",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `GitHub returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateGitLab(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://gitlab.com/api/v4/user", {
    headers: { "PRIVATE-TOKEN": token },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "GitLab token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "GitLab token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `GitLab returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateStripe(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.stripe.com/v1/charges?limit=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status >= 200 && res.status < 300)
    return { status: "ACTIVE", message: "Stripe key active", checkedAt: now };
  if (res.status === 401)
    return { status: "REVOKED", message: "Stripe key invalid", checkedAt: now };
  return {
    status: "UNVERIFIABLE",
    message: `Stripe returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateSlack(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    return {
      status: "UNVERIFIABLE",
      message: `Slack API returned HTTP ${res.status}`,
      checkedAt: now,
    };
  }
  try {
    const body = (await res.json()) as { ok: boolean };
    if (body.ok)
      return {
        status: "ACTIVE",
        message: "Slack token verified",
        checkedAt: now,
      };
    return { status: "REVOKED", message: "Slack token invalid", checkedAt: now };
  } catch {
    return {
      status: "UNVERIFIABLE",
      message: "Slack API returned invalid JSON",
      checkedAt: now,
    };
  }
}

async function validateAnthropic(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Anthropic key verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Anthropic key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Anthropic returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateOpenAI(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return { status: "ACTIVE", message: "OpenAI key verified", checkedAt: now };
  if (res.status === 401)
    return { status: "REVOKED", message: "OpenAI key invalid", checkedAt: now };
  return {
    status: "UNVERIFIABLE",
    message: `OpenAI returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateHuggingFace(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://huggingface.co/api/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "HuggingFace token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "HuggingFace token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `HuggingFace returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateSendGrid(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.sendgrid.com/v3/user/profile", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "SendGrid key verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "SendGrid key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `SendGrid returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateTwilio(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // Twilio tokens are "ACXXXXXXXX:authtoken" — try info endpoint with basic auth
  const [sid, authToken] = token.split(":");
  if (!sid || !authToken)
    return {
      status: "UNVERIFIABLE",
      message: "Invalid Twilio credential format",
      checkedAt: now,
    };
  // Use Buffer for UTF-8 safe base64 encoding (btoa fails on non-ASCII)
  const credentials = typeof Buffer !== 'undefined'
    ? Buffer.from(`${sid}:${authToken}`).toString('base64')
    : btoa(unescape(encodeURIComponent(`${sid}:${authToken}`)));
  
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
    {
      headers: { Authorization: `Basic ${credentials}` },
    },
  );
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Twilio credentials verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Twilio credentials invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Twilio returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateShopify(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // Shopify admin tokens require a shop domain — can only partially validate format
  if (/^shpat_[a-fA-F0-9]{32}/.test(token)) {
    return {
      status: "UNVERIFIABLE",
      message: "Shopify token format valid — cannot verify without shop domain",
      checkedAt: now,
    };
  }
  return {
    status: "FALSE_POSITIVE",
    message: "Invalid Shopify token format",
    checkedAt: now,
  };
}

async function validateAWS(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // AWS access key ID format check: AKIA... — actual check requires secret key too
  if (/^AKIA[0-9A-Z]{16}$/.test(token)) {
    return {
      status: "UNVERIFIABLE",
      message: "AWS key ID format valid — STS check requires secret key",
      checkedAt: now,
    };
  }
  return {
    status: "FALSE_POSITIVE",
    message: "Invalid AWS key ID format",
    checkedAt: now,
  };
}

async function validateDigitalOcean(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.digitalocean.com/v2/account", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "DigitalOcean token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "DigitalOcean token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `DigitalOcean returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateMailchimp(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // Mailchimp keys end in -us1 etc. — need DC prefix for endpoint
  const dc = token.split("-").pop();
  if (!dc)
    return {
      status: "UNVERIFIABLE",
      message: "Cannot extract Mailchimp DC",
      checkedAt: now,
    };
  // Use Buffer for UTF-8 safe base64 encoding (btoa fails on non-ASCII)
  const credentials = typeof Buffer !== 'undefined'
    ? Buffer.from(`any:${token}`).toString('base64')
    : btoa(unescape(encodeURIComponent(`any:${token}`)));
  
  const res = await fetchWithTimeout(`https://${dc}.api.mailchimp.com/3.0/ping`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Mailchimp key verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Mailchimp key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Mailchimp returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateBraintree(
  token: string,
  now: string,
): Promise<ValidationResult> {
  return {
    status: "UNVERIFIABLE",
    message: "Braintree validation requires sandbox/production env context",
    checkedAt: now,
  };
}

async function validateSquare(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://connect.squareup.com/v2/locations", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": "2024-01-17",
    },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Square token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Square token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Square returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateDatadog(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.datadoghq.com/api/v1/validate", {
    headers: { "DD-API-KEY": token },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Datadog API key verified",
      checkedAt: now,
    };
  if (res.status === 403)
    return {
      status: "REVOKED",
      message: "Datadog API key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Datadog returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateNewRelic(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.newrelic.com/graphql", {
    method: "POST",
    headers: { "API-Key": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ actor { user { name } } }" }),
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "New Relic API key verified",
      checkedAt: now,
    };
  if (res.status === 403)
    return {
      status: "REVOKED",
      message: "New Relic API key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `New Relic returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateNpm(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://registry.npmjs.org/-/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return { status: "ACTIVE", message: "npm token verified", checkedAt: now };
  if (res.status === 401)
    return { status: "REVOKED", message: "npm token invalid", checkedAt: now };
  return {
    status: "UNVERIFIABLE",
    message: `npm returned ${res.status}`,
    checkedAt: now,
  };
}

async function validatePyPI(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // PyPI tokens are hard to validate without publishing; check format
  if (/^pypi-[A-Za-z0-9_-]{50,}/.test(token)) {
    return {
      status: "UNVERIFIABLE",
      message: "PyPI token format valid — cannot verify without publishing",
      checkedAt: now,
    };
  }
  return {
    status: "FALSE_POSITIVE",
    message: "Invalid PyPI token format",
    checkedAt: now,
  };
}

async function validateDockerHub(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://hub.docker.com/v2/user/", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "DockerHub token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "DockerHub token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `DockerHub returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateFirebase(
  token: string,
  now: string,
): Promise<ValidationResult> {
  return {
    status: "UNVERIFIABLE",
    message: "Firebase tokens require project context",
    checkedAt: now,
  };
}

async function validateAlgolia(
  token: string,
  now: string,
): Promise<ValidationResult> {
  return {
    status: "UNVERIFIABLE",
    message: "Algolia admin key validation requires app ID",
    checkedAt: now,
  };
}

async function validateOkta(
  token: string,
  now: string,
): Promise<ValidationResult> {
  return {
    status: "UNVERIFIABLE",
    message: "Okta tokens require domain context",
    checkedAt: now,
  };
}



async function validateHeroku(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.heroku.com/account", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.heroku+json; version=3",
    },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Heroku token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Heroku token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Heroku returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateNetlify(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.netlify.com/api/v1/user", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Netlify token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Netlify token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Netlify returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateVercel(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.vercel.com/v2/user", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Vercel token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Vercel token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Vercel returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateLinear(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ viewer { id name } }" }),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return {
        status: "REVOKED",
        message: "Linear token invalid",
        checkedAt: now,
      };
    }
    return {
      status: "UNVERIFIABLE",
      message: `Linear API returned HTTP ${res.status}`,
      checkedAt: now,
    };
  }
  try {
    const body = (await res.json()) as { data?: unknown; errors?: unknown };
    if (body.data)
      return {
        status: "ACTIVE",
        message: "Linear token verified",
        checkedAt: now,
      };
    return { status: "REVOKED", message: "Linear token invalid", checkedAt: now };
  } catch {
    return {
      status: "UNVERIFIABLE",
      message: "Linear API returned invalid JSON",
      checkedAt: now,
    };
  }
}

async function validateNotion(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Notion token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Notion token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Notion returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateDiscord(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Discord bot token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Discord bot token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Discord returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateTelegram(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getMe`);
  if (!res.ok) {
    if (res.status === 401 || res.status === 404) {
      return {
        status: "REVOKED",
        message: "Telegram bot token invalid",
        checkedAt: now,
      };
    }
    return {
      status: "UNVERIFIABLE",
      message: `Telegram API returned HTTP ${res.status}`,
      checkedAt: now,
    };
  }
  try {
    const body = (await res.json()) as { ok: boolean };
    if (body.ok)
      return {
        status: "ACTIVE",
        message: "Telegram bot token verified",
        checkedAt: now,
      };
    return {
      status: "REVOKED",
      message: "Telegram bot token invalid",
      checkedAt: now,
    };
  } catch {
    return {
      status: "UNVERIFIABLE",
      message: "Telegram API returned invalid JSON",
      checkedAt: now,
    };
  }
}

// ---------------------------------------------------------------------------
// Newly ported providers (SecretScout validator.rs parity)
// ---------------------------------------------------------------------------

async function validateDropbox(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout(
    "https://api.dropboxapi.com/2/users/get_current_account",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Dropbox token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Dropbox token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Dropbox returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateTwitch(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // Twitch app-access tokens are validated via /oauth2/validate (no Client-ID needed)
  const res = await fetchWithTimeout("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Twitch token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Twitch token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Twitch returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateZoom(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.zoom.us/v2/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return { status: "ACTIVE", message: "Zoom token verified", checkedAt: now };
  if (res.status === 401)
    return { status: "REVOKED", message: "Zoom token invalid", checkedAt: now };
  return {
    status: "UNVERIFIABLE",
    message: `Zoom returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateAsana(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://app.asana.com/api/1.0/users/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Asana token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Asana token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Asana returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateMailgun(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // Mailgun API keys use HTTP basic auth with user "api"
  // Use Buffer for UTF-8 safe base64 encoding (btoa fails on non-ASCII)
  const credentials = typeof Buffer !== 'undefined'
    ? Buffer.from(`api:${token}`).toString('base64')
    : btoa(unescape(encodeURIComponent(`api:${token}`)));
  
  const res = await fetchWithTimeout("https://api.mailgun.net/v3/domains", {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Mailgun key verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Mailgun key invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Mailgun returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateSentry(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://sentry.io/api/0/projects/", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Sentry token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Sentry token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Sentry returned ${res.status}`,
    checkedAt: now,
  };
}

async function validateAirtable(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const res = await fetchWithTimeout("https://api.airtable.com/v0/meta/whoami", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "Airtable token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "Airtable token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `Airtable returned ${res.status}`,
    checkedAt: now,
  };
}

async function validatePayPal(
  token: string,
  now: string,
): Promise<ValidationResult> {
  // PayPal access tokens are Bearer tokens issued by /v1/oauth2/token
  // We can verify via /v1/oauth2/token/userinfo
  const res = await fetchWithTimeout(
    "https://api-m.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1",
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (res.status === 200)
    return {
      status: "ACTIVE",
      message: "PayPal token verified",
      checkedAt: now,
    };
  if (res.status === 401)
    return {
      status: "REVOKED",
      message: "PayPal token invalid",
      checkedAt: now,
    };
  return {
    status: "UNVERIFIABLE",
    message: `PayPal returned ${res.status}`,
    checkedAt: now,
  };
}

// ---------------------------------------------------------------------------
// RSA / PEM private-key proof-of-possession (sign + verify via crypto.subtle)
// Mirrors SecretScout validator.rs sign_and_verify_rsa_key().
// Confirms the PEM is a well-formed, usable RSA private key without any
// network call. Critical-severity findings get ACTIVE instead of UNVERIFIABLE.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PKCS#1 → PKCS#8 DER wrapper
// "-----BEGIN RSA PRIVATE KEY-----" (PKCS#1, the traditional/legacy OpenSSL
// `RSAPrivateKey` ASN.1 structure — still extremely common) encodes the key
// WITHOUT the PrivateKeyInfo wrapper that crypto.subtle.importKey('pkcs8', ...)
// requires. Without this, importKey throws on every PKCS#1 key and a real,
// active leaked key gets misclassified purely on encoding, not validity.
// This wraps the PKCS#1 DER in a minimal PKCS#8 PrivateKeyInfo envelope
// (version 0 + rsaEncryption AlgorithmIdentifier + OCTET STRING) so it can be
// imported normally.
// ---------------------------------------------------------------------------

function derLength(len: number): number[] {
  if (len < 0x80) return [len];
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derWrap(tag: number, content: Uint8Array): Uint8Array {
  const lenBytes = derLength(content.length);
  const out = new Uint8Array(1 + lenBytes.length + content.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(content, 1 + lenBytes.length);
  return out;
}

// SEQUENCE { INTEGER 0 } — PKCS#8 Version
const PKCS8_VERSION_ZERO = new Uint8Array([0x02, 0x01, 0x00]);

// SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL } — AlgorithmIdentifier
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

function pkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const privateKeyOctetString = derWrap(0x04, pkcs1Der); // OCTET STRING { RSAPrivateKey }
  const body = new Uint8Array(
    PKCS8_VERSION_ZERO.length +
      RSA_ALGORITHM_IDENTIFIER.length +
      privateKeyOctetString.length,
  );
  let offset = 0;
  body.set(PKCS8_VERSION_ZERO, offset);
  offset += PKCS8_VERSION_ZERO.length;
  body.set(RSA_ALGORITHM_IDENTIFIER, offset);
  offset += RSA_ALGORITHM_IDENTIFIER.length;
  body.set(privateKeyOctetString, offset);
  return derWrap(0x30, body); // outer SEQUENCE — PrivateKeyInfo
}

function decodeJwt(token: string): any {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const jsonStr = atob(payloadB64);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

async function validateGoogleApiKey(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const key = token.split("|")[0]!;
  try {
    const url = `https://www.googleapis.com/identitytoolkit/v3/retdb/getProjectConfig?key=${key}`;
    const res = await fetchWithTimeout(url, { method: "POST" });
    const status = res.status;
    
    if (status === 200) {
      return {
        status: "ACTIVE",
        message: "Google API key is active and valid (Identity Toolkit config check returned 200)",
        checkedAt: now,
      };
    }
    
    const body = (await res.json().catch(() => ({}))) as any;
    const errorMsg = body?.error?.message || "";
    
    if (errorMsg.includes("API key not valid")) {
      return {
        status: "REVOKED",
        message: `Google API key is invalid/revoked: ${errorMsg}`,
        checkedAt: now,
      };
    }
    
    if (errorMsg.includes("API_KEY_SERVICE_BLOCKED") || errorMsg.includes("requests are blocked")) {
      return {
        status: "ACTIVE",
        message: `Google API key is active (service restricted/blocked: ${errorMsg})`,
        checkedAt: now,
      };
    }
    
    return {
      status: "UNVERIFIABLE",
      message: `Google API key check returned status ${status}: ${errorMsg || "Unknown error"}`,
      checkedAt: now,
    };
  } catch (e) {
    return {
      status: "UNVERIFIABLE",
      message: `Network error verifying Google API key: ${e instanceof Error ? e.message : String(e)}`,
      checkedAt: now,
    };
  }
}

async function validateSupabaseKey(
  token: string,
  now: string,
): Promise<ValidationResult> {
  const cleanToken = token.split("|")[0]!;
  const payload = decodeJwt(cleanToken);
  if (!payload || !payload.ref) {
    return {
      status: "UNVERIFIABLE",
      message: "JWT token does not contain Supabase project reference",
      checkedAt: now,
    };
  }
  
  const ref = payload.ref;
  try {
    const url = `https://${ref}.supabase.co/rest/v1/`;
    const res = await fetchWithTimeout(url, {
      headers: {
        apikey: cleanToken,
        Authorization: `Bearer ${cleanToken}`,
      },
    });
    
    if (res.status === 200 || res.status === 300 || res.status === 404) {
      return {
        status: "ACTIVE",
        message: `Supabase key is active (REST API returned status ${res.status})`,
        checkedAt: now,
      };
    }
    
    if (res.status === 401 || res.status === 403) {
      return {
        status: "REVOKED",
        message: `Supabase key is unauthorized/revoked (REST API returned status ${res.status})`,
        checkedAt: now,
      };
    }
    
    return {
      status: "UNVERIFIABLE",
      message: `Supabase check returned unexpected status ${res.status}`,
      checkedAt: now,
    };
  } catch (e) {
    return {
      status: "UNVERIFIABLE",
      message: `Network error verifying Supabase key: ${e instanceof Error ? e.message : String(e)}`,
      checkedAt: now,
    };
  }
}

async function validatePrivateKey(
  pem: string,
  now: string,
): Promise<ValidationResult> {
  try {
    // Strip PEM headers and decode DER
    const b64 = pem
      .replace(/-----BEGIN[^-]*-----/g, "")
      .replace(/-----END[^-]*-----/g, "")
      .replace(/\s+/g, "");
    if (!b64)
      return {
        status: "UNVERIFIABLE",
        message: "Empty PEM body",
        checkedAt: now,
      };

    let der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    let privateKey: any;
    let algorithm: any;
    let keyType = "";

    try {
      // 1. Try RSA
      let rsaDer = der;
      if (/-----BEGIN RSA PRIVATE KEY-----/.test(pem)) {
        rsaDer = pkcs1ToPkcs8(der) as any;
      }
      privateKey = await crypto.subtle.importKey(
        "pkcs8",
        rsaDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"],
      );
      algorithm = "RSASSA-PKCS1-v1_5";
      keyType = "RSA";
    } catch (rsaErr) {
      // 2. Try ECDSA P-256
      try {
        privateKey = await crypto.subtle.importKey(
          "pkcs8",
          der,
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign"],
        );
        algorithm = { name: "ECDSA", hash: { name: "SHA-256" } };
        keyType = "EC (P-256)";
      } catch (ec256Err) {
        // 3. Try ECDSA P-384
        try {
          privateKey = await crypto.subtle.importKey(
            "pkcs8",
            der,
            { name: "ECDSA", namedCurve: "P-384" },
            true,
            ["sign"],
          );
          algorithm = { name: "ECDSA", hash: { name: "SHA-384" } };
          keyType = "EC (P-384)";
        } catch (ec384Err) {
          // 4. Try ECDSA P-521
          privateKey = await crypto.subtle.importKey(
            "pkcs8",
            der,
            { name: "ECDSA", namedCurve: "P-521" },
            true,
            ["sign"],
          );
          algorithm = { name: "ECDSA", hash: { name: "SHA-512" } };
          keyType = "EC (P-521)";
        }
      }
    }

    // Sign a fixed test payload
    const payload = new TextEncoder().encode(
      "reposcout-key-proof-of-possession",
    );
    const signature = await crypto.subtle.sign(
      algorithm,
      privateKey,
      payload,
    );

    // Export the public key and verify the signature
    let publicKey: CryptoKey;
    if (keyType.startsWith("EC")) {
      const jwk = await crypto.subtle.exportKey("jwk", privateKey);
      const { d, ...publicJwk } = jwk;
      publicJwk.key_ops = ["verify"];
      publicKey = await crypto.subtle.importKey(
        "jwk",
        publicJwk,
        { name: "ECDSA", namedCurve: keyType.match(/P-\d+/)?.[0] },
        false,
        ["verify"],
      );
    } else {
      const publicKeyDer = await crypto.subtle.exportKey("spki", privateKey);
      publicKey = await crypto.subtle.importKey(
        "spki",
        publicKeyDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }

    const valid = await crypto.subtle.verify(
      algorithm,
      publicKey,
      signature,
      payload,
    );

    if (valid) {
      return {
        status: "ACTIVE",
        message: `${keyType} private key passed sign+verify proof-of-possession`,
        checkedAt: now,
      };
    }
    return {
      status: "UNVERIFIABLE",
      message: `${keyType} sign+verify mismatch — unexpected`,
      checkedAt: now,
    };
  } catch (e) {
    return {
      status: "UNVERIFIABLE",
      message: `Could not verify private key: ${e instanceof Error ? e.message : String(e)}`,
      checkedAt: now,
    };
  }
}
