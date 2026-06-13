"use strict";
// src/lib/validator.ts
// Port of secretscout-core/src/validator.rs
// External API credential checks for 30+ providers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateCredential = validateCredential;
// ---------------------------------------------------------------------------
// Pattern ID → validator dispatch
// ---------------------------------------------------------------------------
/**
 * Attempt to validate a credential against its provider's API.
 * Returns UNVERIFIABLE for unknown patterns or network errors.
 */
async function validateCredential(patternId, token) {
    const now = new Date().toISOString();
    const id = patternId.toLowerCase();
    try {
        if (id.includes("github"))
            return await validateGitHub(token, now);
        if (id.includes("gitlab"))
            return await validateGitLab(token, now);
        if (id.includes("stripe"))
            return await validateStripe(token, now);
        if (id.includes("slack"))
            return await validateSlack(token, now);
        if (id.includes("anthropic") || id.includes("claude"))
            return await validateAnthropic(token, now);
        if (id.includes("openai"))
            return await validateOpenAI(token, now);
        if (id.includes("huggingface") || id.includes("hf-"))
            return await validateHuggingFace(token, now);
        if (id.includes("sendgrid"))
            return await validateSendGrid(token, now);
        if (id.includes("twilio"))
            return await validateTwilio(token, now);
        if (id.includes("shopify"))
            return await validateShopify(token, now);
        if (id.includes("aws") || id.includes("amazon"))
            return await validateAWS(token, now);
        if (id.includes("digitalocean"))
            return await validateDigitalOcean(token, now);
        if (id.includes("mailchimp"))
            return await validateMailchimp(token, now);
        if (id.includes("braintree"))
            return await validateBraintree(token, now);
        if (id.includes("square"))
            return await validateSquare(token, now);
        if (id.includes("datadog"))
            return await validateDatadog(token, now);
        if (id.includes("newrelic"))
            return await validateNewRelic(token, now);
        if (id.includes("npm"))
            return await validateNpm(token, now);
        if (id.includes("pypi"))
            return await validatePyPI(token, now);
        if (id.includes("dockerhub") || id.includes("docker-hub"))
            return await validateDockerHub(token, now);
        if (id.includes("firebase"))
            return await validateFirebase(token, now);
        if (id.includes("algolia"))
            return await validateAlgolia(token, now);
        if (id.includes("okta"))
            return await validateOkta(token, now);
        if (id.includes("cloudflare"))
            return await validateCloudflare(token, now);
        if (id.includes("heroku"))
            return await validateHeroku(token, now);
        if (id.includes("netlify"))
            return await validateNetlify(token, now);
        if (id.includes("vercel"))
            return await validateVercel(token, now);
        if (id.includes("linear"))
            return await validateLinear(token, now);
        if (id.includes("notion"))
            return await validateNotion(token, now);
        if (id.includes("discord"))
            return await validateDiscord(token, now);
        if (id.includes("telegram"))
            return await validateTelegram(token, now);
        // Newly ported providers
        if (id.includes("dropbox"))
            return await validateDropbox(token, now);
        if (id.includes("twitch"))
            return await validateTwitch(token, now);
        if (id.includes("zoom"))
            return await validateZoom(token, now);
        if (id.includes("asana"))
            return await validateAsana(token, now);
        if (id.includes("mailgun"))
            return await validateMailgun(token, now);
        if (id.includes("sentry"))
            return await validateSentry(token, now);
        if (id.includes("airtable"))
            return await validateAirtable(token, now);
        if (id.includes("paypal"))
            return await validatePayPal(token, now);
        // RSA / private-key proof-of-possession
        if (id.includes("private-key") || id.includes("rsa") || id.includes("pem"))
            return await validatePrivateKey(token, now);
    }
    catch (e) {
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
async function validateGitHub(token, now) {
    const res = await fetch("https://api.github.com/user", {
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
async function validateGitLab(token, now) {
    const res = await fetch("https://gitlab.com/api/v4/user", {
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
async function validateStripe(token, now) {
    const res = await fetch("https://api.stripe.com/v1/charges?limit=1", {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 401)
        return { status: "ACTIVE", message: "Stripe key active", checkedAt: now };
    return { status: "REVOKED", message: "Stripe key invalid", checkedAt: now };
}
async function validateSlack(token, now) {
    const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
    });
    const body = (await res.json());
    if (body.ok)
        return {
            status: "ACTIVE",
            message: "Slack token verified",
            checkedAt: now,
        };
    return { status: "REVOKED", message: "Slack token invalid", checkedAt: now };
}
async function validateAnthropic(token, now) {
    const res = await fetch("https://api.anthropic.com/v1/models", {
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
async function validateOpenAI(token, now) {
    const res = await fetch("https://api.openai.com/v1/models", {
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
async function validateHuggingFace(token, now) {
    const res = await fetch("https://huggingface.co/api/whoami", {
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
async function validateSendGrid(token, now) {
    const res = await fetch("https://api.sendgrid.com/v3/user/profile", {
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
async function validateTwilio(token, now) {
    // Twilio tokens are "ACXXXXXXXX:authtoken" — try info endpoint with basic auth
    const [sid, authToken] = token.split(":");
    if (!sid || !authToken)
        return {
            status: "UNVERIFIABLE",
            message: "Invalid Twilio credential format",
            checkedAt: now,
        };
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
        headers: { Authorization: `Basic ${btoa(`${sid}:${authToken}`)}` },
    });
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
async function validateShopify(token, now) {
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
async function validateAWS(token, now) {
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
async function validateDigitalOcean(token, now) {
    const res = await fetch("https://api.digitalocean.com/v2/account", {
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
async function validateMailchimp(token, now) {
    // Mailchimp keys end in -us1 etc. — need DC prefix for endpoint
    const dc = token.split("-").pop();
    if (!dc)
        return {
            status: "UNVERIFIABLE",
            message: "Cannot extract Mailchimp DC",
            checkedAt: now,
        };
    const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/ping`, {
        headers: { Authorization: `Basic ${btoa(`any:${token}`)}` },
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
async function validateBraintree(token, now) {
    return {
        status: "UNVERIFIABLE",
        message: "Braintree validation requires sandbox/production env context",
        checkedAt: now,
    };
}
async function validateSquare(token, now) {
    const res = await fetch("https://connect.squareup.com/v2/locations", {
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
async function validateDatadog(token, now) {
    const res = await fetch("https://api.datadoghq.com/api/v1/validate", {
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
async function validateNewRelic(token, now) {
    const res = await fetch("https://api.newrelic.com/graphql", {
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
async function validateNpm(token, now) {
    const res = await fetch("https://registry.npmjs.org/-/whoami", {
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
async function validatePyPI(token, now) {
    const res = await fetch("https://pypi.org/pypi?:action=list_classifiers", {
        headers: { Authorization: `Bearer ${token}` },
    });
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
async function validateDockerHub(token, now) {
    const res = await fetch("https://hub.docker.com/v2/user/", {
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
async function validateFirebase(token, now) {
    return {
        status: "UNVERIFIABLE",
        message: "Firebase tokens require project context",
        checkedAt: now,
    };
}
async function validateAlgolia(token, now) {
    return {
        status: "UNVERIFIABLE",
        message: "Algolia admin key validation requires app ID",
        checkedAt: now,
    };
}
async function validateOkta(token, now) {
    return {
        status: "UNVERIFIABLE",
        message: "Okta tokens require domain context",
        checkedAt: now,
    };
}
async function validateCloudflare(token, now) {
    const res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json());
    if (body.success)
        return {
            status: "ACTIVE",
            message: "Cloudflare token verified",
            checkedAt: now,
        };
    return {
        status: "REVOKED",
        message: "Cloudflare token invalid",
        checkedAt: now,
    };
}
async function validateHeroku(token, now) {
    const res = await fetch("https://api.heroku.com/account", {
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
async function validateNetlify(token, now) {
    const res = await fetch("https://api.netlify.com/api/v1/user", {
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
async function validateVercel(token, now) {
    const res = await fetch("https://api.vercel.com/v2/user", {
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
async function validateLinear(token, now) {
    const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
    });
    const body = (await res.json());
    if (body.data)
        return {
            status: "ACTIVE",
            message: "Linear token verified",
            checkedAt: now,
        };
    return { status: "REVOKED", message: "Linear token invalid", checkedAt: now };
}
async function validateNotion(token, now) {
    const res = await fetch("https://api.notion.com/v1/users/me", {
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
async function validateDiscord(token, now) {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
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
async function validateTelegram(token, now) {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json());
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
}
// ---------------------------------------------------------------------------
// Newly ported providers (SecretScout validator.rs parity)
// ---------------------------------------------------------------------------
async function validateDropbox(token, now) {
    const res = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
    });
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
async function validateTwitch(token, now) {
    // Twitch app-access tokens are validated via /oauth2/validate (no Client-ID needed)
    const res = await fetch("https://id.twitch.tv/oauth2/validate", {
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
async function validateZoom(token, now) {
    const res = await fetch("https://api.zoom.us/v2/users/me", {
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
async function validateAsana(token, now) {
    const res = await fetch("https://app.asana.com/api/1.0/users/me", {
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
async function validateMailgun(token, now) {
    // Mailgun API keys use HTTP basic auth with user "api"
    const res = await fetch("https://api.mailgun.net/v3/domains", {
        headers: { Authorization: `Basic ${btoa(`api:${token}`)}` },
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
async function validateSentry(token, now) {
    const res = await fetch("https://sentry.io/api/0/projects/", {
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
async function validateAirtable(token, now) {
    const res = await fetch("https://api.airtable.com/v0/meta/whoami", {
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
async function validatePayPal(token, now) {
    // PayPal access tokens are Bearer tokens issued by /v1/oauth2/token
    // We can verify via /v1/oauth2/token/userinfo
    const res = await fetch("https://api-m.paypal.com/v1/identity/oauth2/userinfo?schema=paypalv1.1", {
        headers: { Authorization: `Bearer ${token}` },
    });
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
function derLength(len) {
    if (len < 0x80)
        return [len];
    const bytes = [];
    let n = len;
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n >>= 8;
    }
    return [0x80 | bytes.length, ...bytes];
}
function derWrap(tag, content) {
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
function pkcs1ToPkcs8(pkcs1Der) {
    const privateKeyOctetString = derWrap(0x04, pkcs1Der); // OCTET STRING { RSAPrivateKey }
    const body = new Uint8Array(PKCS8_VERSION_ZERO.length +
        RSA_ALGORITHM_IDENTIFIER.length +
        privateKeyOctetString.length);
    let offset = 0;
    body.set(PKCS8_VERSION_ZERO, offset);
    offset += PKCS8_VERSION_ZERO.length;
    body.set(RSA_ALGORITHM_IDENTIFIER, offset);
    offset += RSA_ALGORITHM_IDENTIFIER.length;
    body.set(privateKeyOctetString, offset);
    return derWrap(0x30, body); // outer SEQUENCE — PrivateKeyInfo
}
async function validatePrivateKey(pem, now) {
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
        // "-----BEGIN RSA PRIVATE KEY-----" is PKCS#1 — wrap it in a PKCS#8
        // PrivateKeyInfo envelope before handing it to crypto.subtle.
        if (/-----BEGIN RSA PRIVATE KEY-----/.test(pem)) {
            der = pkcs1ToPkcs8(der);
        }
        // Import as RSASSA-PKCS1-v1_5 signing key
        const privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, // extractable — needed to re-export public key
        ["sign"]);
        // Sign a fixed test payload
        const payload = new TextEncoder().encode("reposcout-key-proof-of-possession");
        const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, payload);
        // Export the public key and verify the signature
        const publicKeyDer = await crypto.subtle.exportKey("spki", privateKey);
        const publicKey = await crypto.subtle.importKey("spki", publicKeyDer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, payload);
        if (valid) {
            return {
                status: "ACTIVE",
                message: "RSA private key passed sign+verify proof-of-possession",
                checkedAt: now,
            };
        }
        return {
            status: "UNVERIFIABLE",
            message: "RSA sign+verify mismatch — unexpected",
            checkedAt: now,
        };
    }
    catch (e) {
        // importKey throws on formats this validator doesn't handle (EC keys,
        // OpenSSH's own container format, encrypted PKCS#8, or genuinely
        // malformed PEM). That's a parser limitation, not proof the credential
        // is fake — return UNVERIFIABLE so it gets a second look from the LLM
        // classifier instead of being short-circuited to FALSE_POSITIVE.
        return {
            status: "UNVERIFIABLE",
            message: `Could not verify as RSA private key: ${e instanceof Error ? e.message : String(e)}`,
            checkedAt: now,
        };
    }
}
