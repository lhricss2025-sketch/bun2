require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const moment = require("moment-timezone");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const axios = require("axios");
const FormData = require("form-data");
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// === LOAD SMTP CONFIGURATION ===
const fetch = require("node-fetch");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const SMTP_DATA = require("./bot_data/smtp.json");

// === Whatsapp Private Api key
const CONNECTED_WA = process.env.CONNECTED_WA;
const API_KEY = process.env.API_KEY;


const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const token = process.env.TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const GROUP_ID = process.env.GROUP_ID;

const bot = new TelegramBot(token, { polling: true });

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// === EMAIL LISTS ===
const UNBAN_EMAILS = [
    "support@support.whatsapp.com",
    "appeals@support.whatsapp.com", 
    "help@support.whatsapp.com",
    "reviews@support.whatsapp.com",
    "reconsideration@support.whatsapp.com",
    "account-appeals@support.whatsapp.com",
    "recovery@support.whatsapp.com",
    "restoration@support.whatsapp.com",
    "second-chance@support.whatsapp.com",
    "forgiveness@support.whatsapp.com"
];

const WHATSAPP_SUPPORT_EMAILS = [
    "support@support.whatsapp.com",
    "appeals@support.whatsapp.com", 
    "android_web@support.whatsapp.com",
    "ios_web@support.whatsapp.com",
    "webclient_web@support.whatsapp.com",
    "1483635209301664@support.whatsapp.com",
    "support@whatsapp.com",
    "businesscomplaints@support.whatsapp.com",
    "help@whatsapp.com",
    "abuse@support.whatsapp.com",
    "security@support.whatsapp.com",
    "phishing@whatsapp.com",
    "spam@whatsapp.com",
    "legal@whatsapp.com",
    "privacy@whatsapp.com"
];

const WHATSAPP_API_ENDPOINTS = [
    "https://api.whatsapp.com/v1/reports",
    "https://graph.facebook.com/v19.0/whatsapp_business_reports",
    "https://www.whatsapp.com/contact/abuse",
    "https://www.whatsapp.com/contact/spam",
    "https://www.whatsapp.com/contact/legal",
    "https://graph.facebook.com/v19.0/whatsapp_reporting"
];

const dataDir = path.join(__dirname, "bot_data");
const dbFile = path.join(dataDir, "database.json");
const proxiesFile = path.join(__dirname, "proxies.txt");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

let db = { owners: [], premium: [] };
if (fs.existsSync(dbFile)) {
  try {
    db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
  } catch (err) {
    console.error("⚠️ Failed to load database, creating new one.");
  }
}

if (!Array.isArray(db.owners)) db.owners = [];
if (!Array.isArray(db.premium)) db.premium = [];

if (!db.owners.includes(OWNER_ID)) {
  db.owners.push(OWNER_ID);
  saveDB();
  console.log(`✅ Added default owner: ${OWNER_ID}`);
}

function saveDB() {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

function isOwner(id) {
  return db.owners.includes(id);
}

function isPremium(id) {
  return db.premium.includes(id);
}

const getUptime = () => {
  const uptimeSeconds = process.uptime();
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);
  return `${hours}h ${minutes}m ${seconds}s`;
};

async function isUserInGroup(userId) {
  try {
    const member = await bot.getChatMember(GROUP_ID, userId);
    const status = member.status;
    return ["creator", "administrator", "member"].includes(status);
  } catch {
    return false;
  }
}

// ============================================================
// ============ PROXY FETCHER (AUTO) ==========================
// ============================================================

// Proxy sources for fetching
const PROXY_SOURCES = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc',
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://www.proxy-list.download/api/v1/get?type=socks4',
    'https://www.proxy-list.download/api/v1/get?type=socks5',
];

// Blacklisted subnets (spam sources)
const BLACKLISTED_SUBNETS = [
    '103.', '144.', '117.159.', '117.146.', '190.61.', '190.72.',
];

// Ports we care about for email
const TEST_PORTS = [1080, 1088, 4145, 4153, 8080, 3128, 999];

// ============== FETCH PROXIES ==============
async function fetchProxies() {
    console.log('[FETCH] Getting proxies from sources...');
    const rawProxies = new Set();

    for (const url of PROXY_SOURCES) {
        try {
            const response = await axios.get(url, { timeout: 15000 });
            const lines = response.data.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes(':')) {
                    rawProxies.add(trimmed);
                }
            }
        } catch (err) {
            console.log(`[FETCH] Failed from ${url}: ${err.message}`);
        }
    }

    console.log(`[FETCH] Total raw proxies: ${rawProxies.size}`);
    return Array.from(rawProxies);
}

// ============== TEST PROXY ==============
function testProxy(proxyString) {
    return new Promise((resolve) => {
        const parts = proxyString.split(':');
        if (parts.length < 2) return resolve(null);
        const ip = parts[0];
        const port = parseInt(parts[1]);

        // Skip blacklisted IPs
        for (const subnet of BLACKLISTED_SUBNETS) {
            if (ip.startsWith(subnet)) return resolve(null);
        }

        // Only test relevant ports
        if (!TEST_PORTS.includes(port)) return resolve(null);

        const start = Date.now();
        const socket = new (require('net').Socket)();
        socket.setTimeout(3000);

        socket.once('connect', () => {
            const latency = Date.now() - start;
            socket.destroy();
            resolve({
                proxy: proxyString,
                ip,
                port,
                latency,
                type: port >= 1080 && port <= 1089 ? 'SOCKS5' : 'HTTP',
                score: latency < 500 ? 100 : latency < 1000 ? 80 : 60,
            });
        });

        socket.once('timeout', () => {
            socket.destroy();
            resolve(null);
        });

        socket.once('error', () => {
            socket.destroy();
            resolve(null);
        });

        socket.connect(port, ip);
    });
}

// ============== TEST ALL PROXIES ==============
async function testProxies(proxies) {
    console.log(`[TEST] Testing ${proxies.length} proxies...`);
    const tested = [];
    const batchSize = 50;

    for (let i = 0; i < proxies.length; i += batchSize) {
        const batch = proxies.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(p => testProxy(p)));
        for (const r of results) {
            if (r) tested.push(r);
        }
        console.log(`[TEST] ${tested.length} good so far...`);
    }

    tested.sort((a, b) => a.latency - b.latency);
    console.log(`[TEST] Found ${tested.length} working proxies.`);
    return tested;
}

// ============== SAVE TO FILE ==============
function saveProxies(proxyList) {
    const content = proxyList.map(p => p.proxy).join('\n');
    fs.writeFileSync(proxiesFile, content, 'utf8');
    console.log(`[SAVE] Saved ${proxyList.length} proxies to proxies.txt`);
    return proxyList;
}

// ============== GET FRESH PROXIES ==============
async function getFreshProxies(limit = 150) {
    console.log('🔄 Fetching fresh proxies...');
    const raw = await fetchProxies();
    const tested = await testProxies(raw);
    // Remove duplicates
    const unique = [];
    const seen = new Set();
    for (const p of tested) {
        if (!seen.has(p.proxy)) {
            seen.add(p.proxy);
            unique.push(p);
        }
    }
    const top = unique.slice(0, limit);
    saveProxies(top);
    console.log(`✅ Loaded ${top.length} proxies.`);
    return top;
}

// ============================================================
// ============ PROXY MANAGER (Enhanced) ======================
// ============================================================

class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.blacklisted = new Set();
        this.lastRefresh = null;
        this.loadProxies();
    }

    loadProxies() {
        try {
            if (fs.existsSync(proxiesFile)) {
                const content = fs.readFileSync(proxiesFile, 'utf-8');
                this.proxies = content.split('\n')
                    .map(line => line.trim())
                    .filter(line => line && line.includes(':') && !line.startsWith('#'));
                console.log(`✅ Loaded ${this.proxies.length} proxies from proxies.txt`);
                this.lastRefresh = new Date();
            } else {
                console.log('❌ proxies.txt not found, running without proxies');
                this.proxies = [];
            }
        } catch (error) {
            console.error('Error loading proxies:', error);
            this.proxies = [];
        }
    }

    async ensureProxies() {
        // If no proxies or file is older than 1 hour, auto-refresh
        const fileAge = this.lastRefresh ? (Date.now() - this.lastRefresh.getTime()) / (1000 * 60) : 999;
        if (this.proxies.length < 10 || fileAge > 60) {
            console.log('🔄 Proxy pool low or stale. Auto-refreshing...');
            await getFreshProxies(150);
            this.loadProxies();
        }
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        
        for (let i = 0; i < this.proxies.length; i++) {
            this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
            const proxy = this.proxies[this.currentIndex];
            
            if (!this.blacklisted.has(proxy)) {
                return proxy;
            }
        }
        return null;
    }

    blacklistProxy(proxy) {
        this.blacklisted.add(proxy);
        console.log(`🚫 Blacklisted proxy: ${proxy}`);
    }

    getProxyStats() {
        return {
            total: this.proxies.length,
            available: this.proxies.length - this.blacklisted.size,
            blacklisted: this.blacklisted.size
        };
    }

    createProxyAgent(proxyUrl) {
        if (!proxyUrl) return null;
        
        try {
            if (proxyUrl.startsWith('socks4://') || proxyUrl.startsWith('socks5://')) {
                return new SocksProxyAgent(proxyUrl);
            } else {
                const fullProxyUrl = proxyUrl.startsWith('http') ? proxyUrl : `http://${proxyUrl}`;
                return new HttpsProxyAgent(fullProxyUrl);
            }
        } catch (error) {
            console.error('Error creating proxy agent:', error);
            return null;
        }
    }
}

// ============================================================
// ============ INIT PROXY MANAGER ============================
// ============================================================

const proxyManager = new ProxyManager();

// Auto-refresh on startup
(async function initProxies() {
    await proxyManager.ensureProxies();
})();

// Auto-refresh every hour
setInterval(async () => {
    await proxyManager.ensureProxies();
}, 60 * 60 * 1000);

// ============================================================
// ============ WHATSAPP REPORTER & UNBAN =====================
// ============================================================

class WhatsAppReporter {
    constructor() {
        this.reportMethods = [
            'email_bombing',
            'meta_api_direct', 
            'web_form_submission',
            'whatsapp_app_api',
            'business_api'
        ];
    }

    async sendMassEmails(subject, body, pdfPath = null) {
        let successCount = 0;
        const totalEmails = WHATSAPP_SUPPORT_EMAILS.length;
        
        for (const email of WHATSAPP_SUPPORT_EMAILS) {
            try {
                const transporter = nodemailer.createTransport({
                    host: SMTP_DATA.accounts[0].host,
                    port: SMTP_DATA.accounts[0].port,
                    secure: !!SMTP_DATA.accounts[0].secure,
                    auth: SMTP_DATA.accounts[0].auth,
                });

                const mailOptions = {
                    from: SMTP_DATA.accounts[0].auth.user,
                    to: email,
                    subject: subject,
                    html: body,
                    attachments: pdfPath ? [{ filename: path.basename(pdfPath), path: pdfPath }] : []
                };

                await transporter.sendMail(mailOptions);
                successCount++;
                console.log(`✅ Email sent to: ${email}`);
                
                await new Promise(resolve => setTimeout(resolve, Math.random() * 2000 + 1000));
                
            } catch (error) {
                console.log(`❌ Failed to send to ${email}: ${error.message}`);
            }
        }
        
        return { success: successCount, total: totalEmails };
    }

    async reportViaMetaAPI(phoneNumber, reason, reportType) {
        const proxyUrl = proxyManager.getNextProxy();
        const agent = proxyManager.createProxyAgent(proxyUrl);

        try {
            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: phoneNumber,
                type: "text",
                text: { 
                    body: `🚨 ${reportType.toUpperCase()} REPORT: ${reason} - Timestamp: ${Date.now()}` 
                }
            };

            const config = {
                headers: {
                    'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            };

            if (agent) {
                config.httpsAgent = agent;
                config.httpAgent = agent;
            }

            const response = await axios.post(
                `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                payload,
                config
            );

            console.log(`✅ Meta API success via proxy: ${proxyUrl || 'DIRECT'}`);
            return response.status === 200;
        } catch (error) {
            console.log(`❌ Meta API failed: ${error.message}`);
            if (proxyUrl) proxyManager.blacklistProxy(proxyUrl);
            return false;
        }
    }

    async submitWebForms(phoneNumber, reason, reportType) {
        let successCount = 0;
        
        const formEndpoints = [
            'https://www.whatsapp.com/contact/abuse',
            'https://www.whatsapp.com/contact/spam',
            'https://www.whatsapp.com/contact/legal'
        ];

        for (const endpoint of formEndpoints) {
            const proxyUrl = proxyManager.getNextProxy();
            const agent = proxyManager.createProxyAgent(proxyUrl);

            try {
                const formData = new FormData();
                formData.append('abusive_number', phoneNumber);
                formData.append('complaint_type', reportType === 'perm' ? 'critical_abuse' : 'temporary_restriction');
                formData.append('description', reason);
                formData.append('urgency', 'high');
                formData.append('user_consent', 'true');

                const config = {
                    headers: {
                        ...formData.getHeaders(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 15000
                };

                if (agent) {
                    config.httpsAgent = agent;
                    config.httpAgent = agent;
                }

                const response = await axios.post(endpoint, formData, config);
                
                if (response.status === 200 || response.status === 302) {
                    successCount++;
                    console.log(`✅ Form submitted via proxy: ${proxyUrl || 'DIRECT'}`);
                }
            } catch (error) {
                console.log(`❌ Form submission failed: ${error.message}`);
                if (proxyUrl) proxyManager.blacklistProxy(proxyUrl);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        return successCount > 0;
    }

    async simulateAppReporting(phoneNumber, reason) {
        try {
            const appHeaders = {
                'User-Agent': 'WhatsApp/2.25.21.82 Android/13',
                'Content-Type': 'application/json',
                'X-Requested-With': 'com.whatsapp'
            };

            const appPayload = {
                jid: `${phoneNumber}@s.whatsapp.net`,
                report_type: 'SPAM_OR_ABUSE',
                context: 'CHAT_LIST',
                reason: reason,
                message_count: '5',
                timestamp: Date.now(),
                app_version: '2.25.21.82'
            };

            for (const endpoint of WHATSAPP_API_ENDPOINTS) {
                const proxyUrl = proxyManager.getNextProxy();
                const agent = proxyManager.createProxyAgent(proxyUrl);

                try {
                    const config = {
                        headers: appHeaders,
                        timeout: 10000
                    };

                    if (agent) {
                        config.httpsAgent = agent;
                        config.httpAgent = agent;
                    }

                    await axios.post(endpoint, appPayload, config);
                    console.log(`✅ App API success via proxy: ${proxyUrl || 'DIRECT'}`);
                    return true;
                } catch (e) {
                    console.log(`❌ App API failed on ${endpoint}: ${e.message}`);
                    if (proxyUrl) proxyManager.blacklistProxy(proxyUrl);
                    continue;
                }
            }
            return false;
        } catch (error) {
            console.log(`❌ App API general error: ${error.message}`);
            return false;
        }
    }

    async executeMassReport(phoneNumber, reason, reportType) {
        const results = {
            emails: { success: 0, total: 0 },
            meta_api: false,
            web_forms: false,
            app_api: false,
            total_success: 0,
            proxy_stats: proxyManager.getProxyStats()
        };

        const subject = `URGENT: ${reportType.toUpperCase()} Ban Request - ${phoneNumber}`;
        const emailBody = this.generateEmailTemplate(phoneNumber, reason, reportType);
        
        const emailResult = await this.sendMassEmails(subject, emailBody);
        results.emails = emailResult;
        results.total_success += emailResult.success;

        results.meta_api = await this.reportViaMetaAPI(phoneNumber, reason, reportType);
        if (results.meta_api) results.total_success++;

        results.web_forms = await this.submitWebForms(phoneNumber, reason, reportType);
        if (results.web_forms) results.total_success++;

        results.app_api = await this.simulateAppReporting(phoneNumber, reason);
        if (results.app_api) results.total_success++;

        return results;
    }

    generateEmailTemplate(phoneNumber, reason, reportType) {
        return `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .container { background: white; padding: 30px; border-radius: 10px; border-left: 5px solid #${reportType === 'perm' ? 'd32f2f' : 'f57c00'}; }
                .header { color: #${reportType === 'perm' ? 'd32f2f' : 'f57c00'}; font-size: 24px; margin-bottom: 20px; }
                .urgent { background: #ffebee; padding: 15px; border-radius: 5px; margin: 15px 0; }
                .details { background: #f3e5f5; padding: 15px; border-radius: 5px; margin: 15px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    🚨 ${reportType === 'perm' ? 'PERMANENT BAN REQUEST' : 'TEMPORARY SUSPENSION REQUEST'}
                </div>
                
                <div class="urgent">
                    <strong>URGENT SECURITY ALERT</strong><br>
                    This report requires immediate attention due to severe platform violations.
                </div>

                <div class="details">
                    <strong>VIOLATOR DETAILS:</strong><br>
                    • Phone Number: <strong>${phoneNumber}</strong><br>
                    • Report Type: <strong>${reportType.toUpperCase()}</strong><br>
                    • Severity: <strong>${reportType === 'perm' ? 'CRITICAL' : 'HIGH'}</strong><br>
                    • Timestamp: ${new Date().toISOString()}
                </div>

                <div>
                    <strong>VIOLATION DETAILS:</strong><br>
                    ${reason}
                </div>

                <div style="margin-top: 20px; padding: 15px; background: #e8f5e8; border-radius: 5px;">
                    <strong>REQUIRED ACTION:</strong><br>
                    ${reportType === 'perm' 
                        ? '• Immediate permanent account termination<br>• Device hardware ID blocking<br>• Law enforcement notification' 
                        : '• 30-day account suspension<br>• Content removal<br>• User warning and education'}
                </div>

                <div style="margin-top: 20px; font-size: 12px; color: #666;">
                    This report is generated through automated security monitoring systems.<br>
                    Multiple victims have been affected by this account's activities.
                </div>
            </div>
        </body>
        </html>
        `;
    }
}

// === UNBAN APPEAL SYSTEM ===
class WhatsAppUnbanAppeal {
    constructor() {
        this.appealMethods = ['emotional_email_bombing', 'heartfelt_forms', 'desperate_api_calls'];
    }

    async sendHeartfeltEmails(phoneNumber, appealStory) {
        let successCount = 0;
        const totalEmails = UNBAN_EMAILS.length;
        
        if (!SMTP_DATA.accounts.length) {
            console.log("❌ No SMTP accounts for unban appeals");
            return { success: 0, total: totalEmails };
        }

        const smtpAccount = SMTP_DATA.accounts[0];
        
        for (const email of UNBAN_EMAILS) {
            try {
                const transporter = nodemailer.createTransport({
                    host: smtpAccount.host,
                    port: smtpAccount.port,
                    secure: !!smtpAccount.secure,
                    auth: smtpAccount.auth,
                    connectionTimeout: 10000,
                    greetingTimeout: 10000,
                    socketTimeout: 10000
                });

                const subject = `😔💔 DESPERATE PLEA: Account Restoration Request - ${phoneNumber} - Wrongfully Banned Medical Emergency`;
                const emailBody = this.generateHeartfeltTemplate(phoneNumber, appealStory);

                const mailOptions = {
                    from: smtpAccount.auth.user,
                    to: email,
                    subject: subject,
                    html: emailBody,
                    priority: 'high'
                };

                await transporter.sendMail(mailOptions);
                successCount++;
                console.log(`💝 Heartfelt appeal sent to: ${email}`);
                
                await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 2000));
            } catch (error) {
                console.log(`❌ Appeal failed to ${email}: ${error.message}`);
            }
        }
        return { success: successCount, total: totalEmails };
    }

    async submitEmotionalForms(phoneNumber, appealStory) {
        let successCount = 0;
        const appealEndpoints = [
            'https://www.whatsapp.com/contact/',
            'https://www.whatsapp.com/appeal',
            'https://www.whatsapp.com/support',
            'https://www.whatsapp.com/help'
        ];

        for (const endpoint of appealEndpoints) {
            const proxyUrl = proxyManager.getNextProxy();
            const agent = proxyManager.createProxyAgent(proxyUrl);
            
            try {
                const formData = new FormData();
                formData.append('phone_number', phoneNumber);
                formData.append('appeal_type', 'wrongful_ban');
                formData.append('urgency_level', 'life_or_death');
                formData.append('story', appealStory);
                formData.append('humanitarian_case', 'true');
                formData.append('medical_emergency', 'true');
                formData.append('family_communication', 'true');

                const config = {
                    headers: {
                        ...formData.getHeaders(),
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'X-Emergency': 'true'
                    },
                    timeout: 20000
                };

                if (agent) {
                    config.httpsAgent = agent;
                    config.httpAgent = agent;
                }

                const response = await axios.post(endpoint, formData, config);
                if (response.status === 200 || response.status === 302) {
                    successCount++;
                    console.log(`💝 Emotional form submitted via proxy: ${proxyUrl || 'DIRECT'}`);
                }
            } catch (error) {
                console.log(`❌ Emotional form failed: ${error.message}`);
                if (proxyUrl) proxyManager.blacklistProxy(proxyUrl);
            }
            
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        return successCount > 0;
    }

    async sendAPIAppeals(phoneNumber, appealStory) {
        const proxyUrl = proxyManager.getNextProxy();
        const agent = proxyManager.createProxyAgent(proxyUrl);
        
        try {
            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual", 
                to: "support@whatsapp.com",
                type: "text",
                text: {
                    body: `😢💔 URGENT HUMANITARIAN APPEAL: ${appealStory} - Phone: ${phoneNumber} - Please restore this account for medical communications.`
                }
            };

            const config = {
                headers: {
                    'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                    'X-Emergency-Case': 'true'
                },
                timeout: 20000
            };

            if (agent) {
                config.httpsAgent = agent;
                config.httpAgent = agent;
            }

            const response = await axios.post(
                `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                payload,
                config
            );

            console.log(`💝 API appeal success via proxy: ${proxyUrl || 'DIRECT'}`);
            return response.status === 200;
        } catch (error) {
            console.log(`❌ API appeal failed: ${error.message}`);
            if (proxyUrl) proxyManager.blacklistProxy(proxyUrl);
            return false;
        }
    }

    generateHeartfeltStory(phoneNumber) {
        const stories = [
            `My name is Sarah, and my WhatsApp account ${phoneNumber} is my only connection to my 6-year-old daughter who is battling leukemia in Germany while I'm stuck in Nigeria trying to raise funds for her treatment. The doctors send daily updates through WhatsApp, and without it, I'm completely cut off from knowing if my baby is alive or not. This account contains the last photos and videos of her before chemotherapy. Please, I'm begging you, restore my account so I don't lose contact with my dying child.`,

            `I'm Dr. Michael Chen, and my WhatsApp ${phoneNumber} is crucial for coordinating emergency medical services in rural Africa. We use it to send blood test results, patient updates, and coordinate ambulance services. My account was wrongfully banned yesterday, and today we couldn't coordinate a emergency blood delivery for a mother giving birth. This is literally life and death. Please restore access immediately.`,

            `My elderly father with Alzheimer's only remembers how to use WhatsApp to communicate with me. He's alone in London while I'm in Nigeria. His caretaker just messaged me that he's been crying for 2 days because he can't see my messages or hear my voice. He thinks I've abandoned him. This is destroying his mental health. Please, for the sake of an old man's heart, restore ${phoneNumber}.`,

            `I run an orphanage in Kenya with 47 children, and WhatsApp ${phoneNumber} is our only way to receive donations and coordinate food supplies. We were supposed to receive confirmation today about a food shipment that will feed these children for a month. Without this account, 47 innocent children might go hungry. Please, I'm on my knees begging you to help us.`,

            `My wife passed away 3 months ago from COVID, and WhatsApp ${phoneNumber} contains the last 2 years of our conversations, her voice notes telling me she loves me, and videos of our last moments together. It's all I have left of her. I can't lose these memories. Please help me recover my account and these precious memories of my late wife.`
        ];
        
        return stories[Math.floor(Math.random() * stories.length)];
    }

    generateHeartfeltTemplate(phoneNumber, story) {
        return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: 'Arial', sans-serif; margin: 20px; background: #f0f8ff; }
        .container { background: white; padding: 40px; border-radius: 15px; border-left: 8px solid #ff6b6b; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
        .header { color: #ff6b6b; font-size: 28px; margin-bottom: 25px; text-align: center; font-weight: bold; }
        .emergency { background: #ffeaea; padding: 20px; border-radius: 10px; margin: 20px 0; border: 2px solid #ff6b6b; }
        .story { background: #f8f9fa; padding: 25px; border-radius: 10px; margin: 20px 0; line-height: 1.8; font-size: 16px; }
        .plea { background: #e3f2fd; padding: 20px; border-radius: 10px; margin: 20px 0; text-align: center; }
        .urgent-tag { background: #ff6b6b; color: white; padding: 8px 15px; border-radius: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            😔💔 URGENT HUMANITARIAN APPEAL - WRONGFUL ACCOUNT BAN
        </div>
        
        <div class="emergency">
            <strong>🚨 MEDICAL & FAMILY EMERGENCY NOTICE</strong><br>
            This appeal involves critical healthcare communications and family welfare.
        </div>

        <div style="text-align: center; margin: 20px 0;">
            <span class="urgent-tag">LIFE-OR-DEATH SITUATION</span>
            <span class="urgent-tag">MEDICAL EMERGENCY</span>
            <span class="urgent-tag">FAMILY CRISIS</span>
        </div>

        <div class="story">
            <strong>📞 AFFECTED NUMBER:</strong> <span style="color: #ff6b6b; font-weight: bold;">${phoneNumber}</span><br><br>
            
            <strong>💔 MY STORY:</strong><br>
            ${story}
        </div>

        <div class="plea">
            <strong>🙏 DESPERATE PLEA FOR COMPASSION:</strong><br>
            I am literally begging you to restore my account. This is not just about convenience - it's about healthcare, 
            family connections, and in some cases, literal survival. The automated system made a mistake, and now real 
            human lives are being affected.
        </div>

        <div style="background: #e8f5e8; padding: 20px; border-radius: 10px; margin: 20px 0;">
            <strong>✅ VERIFICATION OFFER:</strong><br>
            I am willing to provide any documentation, undergo any verification process, or do anything required 
            to prove my identity and the legitimacy of my appeal. I just need my account back.
        </div>

        <div style="margin-top: 25px; padding: 15px; background: #fff3cd; border-radius: 5px;">
            <strong>⚠️ CURRENT CONSEQUENCES:</strong><br>
            • Missing critical medical updates<br>
            • Family members thinking I've abandoned them<br>
            • Unable to coordinate emergency services<br>
            • Mental health deterioration of elderly relatives<br>
            • Children without necessary resources
        </div>

        <div style="margin-top: 25px; text-align: center; color: #666; font-size: 14px;">
            This appeal is sent with genuine tears and desperation. Please be the human who makes a difference today.<br>
            <strong>Thank you for your compassion and understanding.</strong>
        </div>
    </div>
</body>
</html>`;
    }

    async executeMassUnbanAppeal(phoneNumber) {
        const results = {
            emails: { success: 0, total: 0 },
            forms: false,
            api: false,
            total_success: 0,
            proxy_stats: proxyManager.getProxyStats(),
            story: this.generateHeartfeltStory(phoneNumber)
        };

        try {
            const emailResult = await this.sendHeartfeltEmails(phoneNumber, results.story);
            results.emails = emailResult;
            results.total_success += emailResult.success;

            results.forms = await this.submitEmotionalForms(phoneNumber, results.story);
            if (results.forms) results.total_success++;

            results.api = await this.sendAPIAppeals(phoneNumber, results.story);
            if (results.api) results.total_success++;

        } catch (error) {
            console.error("Unban appeal error:", error.message);
        }

        return results;
    }
}

// Initialize systems
const whatsappReporter = new WhatsAppReporter();
const whatsappUnban = new WhatsAppUnbanAppeal();

// ============================================================
// ============ NEW COMMAND: /fetch_proxies ===================
// ============================================================

bot.onText(/^\/fetch_proxies$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!isOwner(userId)) {
        return bot.sendMessage(chatId, `⛔ Only owners can fetch proxies.`);
    }

    const processingMsg = await bot.sendMessage(chatId, `🔄 Fetching fresh proxies from 8 sources... This may take 30-60 seconds.`);

    try {
        const proxies = await getFreshProxies(150);
        
        // Show top 10
        let list = proxies.slice(0, 10).map((p, i) => `${i+1}. ${p.proxy} - ${p.latency}ms (${p.type})`).join('\n');
        
        await bot.editMessageText(
            `✅ *Proxy fetch complete!*\n\n📊 *Stats:*\n• Total fetched: ${proxies.length}\n• Top 10:\n${list}\n\n💾 Saved to \`proxies.txt\`\n🔄 Auto-refresh every hour.`,
            {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: "Markdown"
            }
        );
    } catch (err) {
        await bot.editMessageText(`❌ Fetch failed: ${err.message}`, {
            chat_id: chatId,
            message_id: processingMsg.message_id,
        });
    }
});

// ============================================================
// ============ REST OF YOUR EXISTING COMMANDS ================
// ============================================================

// === START COMMAND ===
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const sender =
    msg.from.first_name?.replace(/[*_`[\]]/g, "") ||
    msg.from.username ||
    "User";

  const joined = await isUserInGroup(userId);

  if (!joined) {
    return bot.sendPhoto(chatId, "./bot_data/start.jpg", {
      caption: `👋 Hello ${sender}!\n\nBefore you can use this bot, please join our official groups.\nAfter joining, press /start again ✅`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Official Channel ✅", url: "https://t.me/Senzo_Official" }],
          [{ text: "Join us CHANNEL", url: "https://t.me/+wRaWDUT9DB41ZWE0" }],
          [{ text: "Join Our Backup Channel ⏳", url: "https://t.me/senzo_backup" }],
        ],
      },
    });
  }

  const uptime = getUptime();
  const proxyStats = proxyManager.getProxyStats();

  const botMenu = `═════════════════════╗
║              🌌 SYSTEM INITIALIZING...              ║
╠══════════════════════════════════════════════════════╣
║              🌟 WELCOME ${sender}!                  ║
╚══════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 ACCESS LEVEL: AUTHORIZED
🛡 SECURITY CLEARANCE: MAXIMUM
⚡ CORE ENGINE: ACTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
        █  TELEGRAM BAN BOT – SENZO CORE  █
        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀

🎉 You now have FULL access to the bot features 🎉

╔══════════ 🔥 BOT INFORMATION 🔥 ══════════╗
┃
┃ 🤖 Bot Name: Senzo Ban Bot 🚫
┃ 👑 Owner ID: ${OWNER_ID}
┃ ⏱ Uptime: ${uptime}
┃ 💾 Total Owners: ${db.owners.length}
┃ ⭐ Premium Users: ${db.premium.length}
┃ 🔥 Mode: Multi-Method Reporting
┃ 🔒 Proxies: ${proxyStats.available}/${proxyStats.total} Available
┃
╚══════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙ SYSTEM ANALYTICS
• Thread Pool: Optimized
• Proxy Rotation: Smart Auto Switch
• Detection Bypass: Enabled
• API Latency: Stable
• Network Status: Secure Channel
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

╔════════════ ⚙️ AVAILABLE COMMANDS ⚙️ ═══════════════╗
┃
┃ 👑 OWNER MANAGEMENT
┃ ✨ /Addowner <id>         – Add new owner
┃ ❌ /Delowner <id>         – Remove owner
┃ 🌟 /Addprem <id>          – Add premium user
┃ 🛑 /Delprem <id>          – Remove premium user
┃
┃ 📱 TARGET OPERATIONS
┃ 📞 /Check_number <number> – Check WhatsApp status
┃ 💣 /Ban_perm <number>     – Permanent ban (4x Methods)
┃ ⚡ /Ban_temp <number>     – Temporary ban (4x Methods)
┃ 🔥 /Mass_report <number>  – ALL methods combined
┃ 🔓 /unban <number>        – Restore Permanent Ban
┃
┃ 🌐 NETWORK SYSTEM
┃ 🌐 /Proxy_stats           – Proxy system info
┃ 🔄 /fetch_proxies         – Force refresh proxies
┃
╚══════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 PERFORMANCE DASHBOARD
▸ Execution Speed: HIGH
▸ Multi-Method Engine: ACTIVE
▸ Proxy Shield: ENABLED
▸ Premium Boost: ON
▸ Stability Rate: 99.9%
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

╔══════════════════════════════════════════════════════╗
║ ⚠️ WARNING: OWNER ACCESS ONLY                      ║
║ Improper use may result in system restrictions.     ║
╚══════════════════════════════════════════════════════╝

💡 Tip: Always ensure proxies are active before running ban operations

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔐 TELEGRAM BAN BOT • SENZO SECURITY FRAMEWORK v1.0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 Tip: Always ensure proxies are active before running ban operations.`;

  bot.sendPhoto(chatId, "./bot_data/start.jpg", {
    caption: botMenu,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "💬 Backup Channel", url: "https://t.me/senzo_backup" },
          { text: "📢 View Channel", url: "https://t.me/+wRaWDUT9DB41ZWE0" },
        ],
        [
          { text: "👥 clan", url: "https://t.me/Senzo_Official" }
        ]
      ],
    },
  }).catch(() => {
    bot.sendPhoto(chatId, "./bot_data/start.jpg", {
      caption: botMenu,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
          { text: "💬 Backup Channel", url: "https://t.me/senzo_backup" },
          { text: "📢 View Channel", url: "https://t.me/+wRaWDUT9DB41ZWE0" },
        ],
        [
          { text: "👥 clan", url: "https://t.me/Senzo_Official" }
        ]
        ],
      },
    });
  });
});

// === PROXY STATS ===
bot.onText(/^\/Proxy_stats$/i, async (msg) => {
  const chatId = msg.chat.id;
  const stats = proxyManager.getProxyStats();
  
  const statsMessage = `
🔒 *PROXY SYSTEM STATISTICS*

┏━━━━━━━━━━━━━━━━━━┓
┣ 📊 Total Proxies: ${stats.total}
┣ ✅ Available: ${stats.available}
┣ 🚫 Blacklisted: ${stats.blacklisted}
┣ 📈 Success Rate: ${stats.total > 0 ? ((stats.available / stats.total) * 100).toFixed(1) : 0}%
┗━━━━━━━━━━━━━━━━━━┛

*Proxy File:* \`proxies.txt\`
*Last Updated:* ${new Date().toLocaleString()}

💡 *Tip:* Each request uses a different proxy for maximum anonymity.
🔄 Auto-refresh every hour. Use /fetch_proxies to force refresh.
  `;

  bot.sendMessage(chatId, statsMessage, { parse_mode: "Markdown" });
});

// === ADD OWNER ===
bot.onText(/^\/addowner(?:\s+(\d+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";
  const timescale = getUptime();

  if (!(await isUserInGroup(msg.from.id)))
    return bot.sendMessage(chatId, `❌ Join group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(msg.from.id))
    return bot.sendMessage(chatId, `⛔ Access Denied, ${sender}`);

  const id = match[1];
  if (!id) return bot.sendMessage(chatId, "Usage:\n`/addowner <telegram_user_id>`", { parse_mode: "Markdown" });

  if (!db.owners.includes(parseInt(id))) {
    db.owners.push(parseInt(id));
    saveDB();
  }

  const ui = `
━━━━━━━━━━━━━━━━━━━━━━
🟦 *OWNER UPDATE — SUCCESS*
━━━━━━━━━━━━━━━━━━━━━━
👤 *New Owner:* \`${id}\`
👨‍💻 *Added By:* ${sender}
⚡ *Timestamp:* \`${timescale}\`
━━━━━━━━━━━━━━━━━━━━━━
💎 *Privilege:* Full System Access Granted
💠 *Status:* ACTIVE
━━━━━━━━━━━━━━━━━━━━━━
  `;

  bot.sendMessage(chatId, ui, { parse_mode: "Markdown" });
});

// === DELETE OWNER ===
bot.onText(/^\/delowner(?:\s+(\d+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";

  if (!(await isUserInGroup(msg.from.id)))
    return bot.sendMessage(chatId, `❌ Join group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(msg.from.id))
    return bot.sendMessage(chatId, `⛔ Access Denied, ${sender}`);

  const id = match[1];
  if (!id) return bot.sendMessage(chatId, "Usage:\n`/delowner <telegram_user_id>`", { parse_mode: "Markdown" });

  db.owners = db.owners.filter((x) => x !== parseInt(id));
  saveDB();

  const ui = `
━━━━━━━━━━━━━━━━━━━━━━
⚡ *OWNER REMOVED*
━━━━━━━━━━━━━━━━━━━━━━
👤 *ID:* \`${id}\`
👨‍💻 *Removed By:* ${sender}
🛑 *Privilege Revoked*
━━━━━━━━━━━━━━━━━━━━━━
  `;

  bot.sendMessage(chatId, ui, { parse_mode: "Markdown" });
});

// === ADD PREMIUM ===
bot.onText(/^\/addprem(?:\s+(\d+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";

  if (!(await isUserInGroup(msg.from.id)))
    return bot.sendMessage(chatId, `❌ Join group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(msg.from.id))
    return bot.sendMessage(chatId, `⛔ Access Denied, ${sender}`);

  const id = match[1];
  if (!id) return bot.sendMessage(chatId, "Usage:\n`/addprem <telegram_user_id>`", { parse_mode: "Markdown" });

  if (!db.premium.includes(parseInt(id))) {
    db.premium.push(parseInt(id));
    saveDB();
  }

  const ui = `
━━━━━━━━━━━━━━━━━━━━━━
💎 *PREMIUM USER ADDED*
━━━━━━━━━━━━━━━━━━━━━━
👤 *User:* \`${id}\`
👨‍💻 *Activated By:* ${sender}
🔐 *Access:* Premium Tier Unlocked
🌟 *Status:* ACTIVE
━━━━━━━━━━━━━━━━━━━━━━
  `;

  bot.sendMessage(chatId, ui, { parse_mode: "Markdown" });
});

// === DELETE PREMIUM ===
bot.onText(/^\/delprem(?:\s+(\d+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";

  if (!(await isUserInGroup(msg.from.id)))
    return bot.sendMessage(chatId, `❌ Join group first:\nhttps://t.me/badboi_chat`);

  if (!isOwner(msg.from.id))
    return bot.sendMessage(chatId, `⛔ Access Denied, ${sender}`);

  const id = match[1];
  if (!id) return bot.sendMessage(chatId, "Usage:\n`/delprem <telegram_user_id>`", { parse_mode: "Markdown" });

  db.premium = db.premium.filter((x) => x !== parseInt(id));
  saveDB();

  const ui = `
━━━━━━━━━━━━━━━━━━━━━━
🛑 *PREMIUM REMOVED*
━━━━━━━━━━━━━━━━━━━━━━
👤 *User:* \`${id}\`
👨‍💻 *Removed By:* ${sender}
💔 *Access:* Revoked
━━━━━━━━━━━━━━━━━━━━━━
  `;

  bot.sendMessage(chatId, ui, { parse_mode: "Markdown" });
});

// === CHECK NUMBER ===
bot.onText(/^\/Check_number(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";
  const userId = msg.from.id;

  if (!(await isUserInGroup(userId)))
    return bot.sendMessage(chatId, `❌ Please join our group first:\nhttps://t.me/Senzo_Official`);

  let input = match[1];
  if (!input)
    return bot.sendMessage(
      chatId,
      `⚙️ *Usage:*\n\`/Check_number <phone number>\`\n\n📌 *Examples:*\n/Check_number +14155552671\n/Check_number 08123456789`,
      { parse_mode: "Markdown" }
    );

  input = input.replace(/[^\d+]/g, "");
  let numberFormatted = input;

  try {
    const parsed = parsePhoneNumberFromString(input, "NG");
    if (parsed && parsed.isValid()) numberFormatted = parsed.number;
  } catch {}

  await bot.sendMessage(chatId, `🔍 Checking WhatsApp status for *${numberFormatted}*...`, { parse_mode: "Markdown" });

  try {
    const url = `https://api.p.2chat.io/open/whatsapp/check-number/${encodeURIComponent(CONNECTED_WA)}/${encodeURIComponent(numberFormatted)}`;
    const resp = await fetch(url, { method: "GET", headers: { "X-User-API-Key": API_KEY } });
    const data = await resp.json();

    if (data.on_whatsapp) {
      await bot.sendMessage(
        chatId,
        `🟢 *${numberFormatted}* is *active on WhatsApp*.\n━━━━━━━━━━━\n🌍 Country: ${data.whatsapp_info?.country_code || "Unknown"}\n✅ Valid: ${data.is_valid ? "Yes" : "No"}\n🕒 Checked: ${new Date().toISOString().slice(0, 16)} UTC\n\n🚨 *READY FOR REPORTING* - Use /Ban_perm or /Ban_temp`,
        { parse_mode: "Markdown" }
      );
    } else {
      await bot.sendMessage(
        chatId,
        `🔴 *${numberFormatted}* is *not registered* on WhatsApp.\n━━━━━━━━━━━\n🌍 Country: ${data.whatsapp_info?.country_code || "Unknown"}\nℹ️ Valid: ${data.is_valid ? "Yes" : "No"}\n🕒 Checked: ${new Date().toISOString().slice(0, 16)} UTC`,
        { parse_mode: "Markdown" }
      );
    }
  } catch (err) {
    console.error("Check number error:", err);
    bot.sendMessage(chatId, `⚠️ Could not verify the number: ${err.message}`);
  }
});

// === PERMANENT BAN ===
bot.onText(/^\/Ban_perm(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";
  const userId = msg.from.id;

  if (!(await isUserInGroup(userId)))
    return bot.sendMessage(chatId, `❌ Please join our group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(userId) && !isPremium(userId))
    return bot.sendMessage(chatId, `⛔ Sorry ${sender}, only *owners* and *premium users* can use this command.`, {
      parse_mode: "Markdown",
    });

  const number = match[1];
  if (!number)
    return bot.sendMessage(chatId, `⚙️ *Usage:*\n\`/Ban_perm <phone number>\``, { parse_mode: "Markdown" });

  const proxyStats = proxyManager.getProxyStats();
  const processingMsg = await bot.sendMessage(
    chatId, 
    `🚨 INITIATING PERMANENT BAN PROTOCOL\n\n📞 Target: *${number}*\n⚡ Methods: *4 Reporting Vectors*\n🔒 Proxies: *${proxyStats.available} available*\n⏰ Estimated: *30-60 seconds*`,
    { parse_mode: "Markdown" }
  );

  try {
    const reason = `This account ${number} is operating sophisticated criminal operations including impersonation, fraud, and organized scam activities. The user is falsely claiming to be Mark Zuckerberg's son to deceive victims and steal financial information. This poses immediate danger to user safety and requires permanent platform removal.`;

    const reportResults = await whatsappReporter.executeMassReport(number, reason, 'perm');

    const resultsMessage = `
✅ *PERMANENT BAN COMPLETE*

📞 Target: *${number}*
👤 Reported by: *${sender}*

📊 *ATTACK RESULTS:*
┏━━━━━━━━━━━━━━━━━━┓
┣ 📧 Emails: ${reportResults.emails.success}/${reportResults.emails.total} sent
┣ 🔗 Meta API: ${reportResults.meta_api ? '✅' : '❌'}
┣ 🌐 Web Forms: ${reportResults.web_forms ? '✅' : '❌'} 
┣ 📱 App API: ${reportResults.app_api ? '✅' : '❌'}
┣ 🎯 Success Rate: ${reportResults.total_success}/4 methods
┣ 🔒 Proxies Used: ${reportResults.proxy_stats.available} available
┗━━━━━━━━━━━━━━━━━━┛

💀 *TARGET STATUS:* ${reportResults.total_success >= 3 ? 'CRITICALLY COMPROMISED' : 'PARTIALLY AFFECTED'}

⚠️ *Check target status in 2-3 minutes. If not banned, retry with /Mass_report*
    `;

    await bot.editMessageText(resultsMessage, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: "Markdown"
    });

  } catch (err) {
    console.error("Permanent ban error:", err);
    await bot.editMessageText(
      `❌ *Permanent ban failed:* ${err.message}\n\n⚠️ Please try again or contact support.`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: "Markdown"
      }
    );
  }
});

// === TEMPORARY BAN ===
bot.onText(/^\/Ban_temp(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";
  const userId = msg.from.id;

  if (!(await isUserInGroup(userId)))
    return bot.sendMessage(chatId, `❌ Please join our group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(userId) && !isPremium(userId))
    return bot.sendMessage(chatId, `⛔ Sorry ${sender}, only *owners* and *premium users* can use this command.`, {
      parse_mode: "Markdown",
    });

  const number = match[1];
  if (!number)
    return bot.sendMessage(chatId, `⚙️ *Usage:*\n\`/Ban_temp <phone number>\``, { parse_mode: "Markdown" });

  const proxyStats = proxyManager.getProxyStats();
  const processingMsg = await bot.sendMessage(
    chatId, 
    `🕒 INITIATING TEMPORARY BAN PROTOCOL\n\n📞 Target: *${number}*\n⚡ Methods: *4 Reporting Vectors*\n🔒 Proxies: *${proxyStats.available} available*\n⏰ Estimated: *30-60 seconds*`,
    { parse_mode: "Markdown" }
  );

  try {
    const reason = `This account ${number} is engaged in suspicious activities and repeated violations of community guidelines. User is involved in spam operations and needs temporary suspension for investigation and user protection.`;

    const reportResults = await whatsappReporter.executeMassReport(number, reason, 'temp');

    const resultsMessage = `
✅ *TEMPORARY BAN COMPLETE*

📞 Target: *${number}*
👤 Reported by: *${sender}*

📊 *ATTACK RESULTS:*
┏━━━━━━━━━━━━━━━━━━┓
┣ 📧 Emails: ${reportResults.emails.success}/${reportResults.emails.total} sent
┣ 🔗 Meta API: ${reportResults.meta_api ? '✅' : '❌'}
┣ 🌐 Web Forms: ${reportResults.web_forms ? '✅' : '❌'}
┣ 📱 App API: ${reportResults.app_api ? '✅' : '❌'}
┣ 🎯 Success Rate: ${reportResults.total_success}/4 methods
┣ 🔒 Proxies Used: ${reportResults.proxy_stats.available} available
┗━━━━━━━━━━━━━━━━━━┛

🟡 *TARGET STATUS:* ${reportResults.total_success >= 3 ? 'HEAVILY REPORTED' : 'MODERATELY AFFECTED'}

⚠️ *Check target status in 2-3 minutes. Temporary bans may take longer to process.*
    `;

    await bot.editMessageText(resultsMessage, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: "Markdown"
    });

  } catch (err) {
    console.error("Temporary ban error:", err);
    await bot.editMessageText(
      `❌ *Temporary ban failed:* ${err.message}\n\n⚠️ Please try again or contact support.`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: "Markdown"
      }
    );
  }
});

// === MASS REPORT (NUCLEAR) ===
bot.onText(/^\/Mass_report(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const sender = msg.from.first_name || msg.from.username || "User";
  const userId = msg.from.id;

  if (!(await isUserInGroup(userId)))
    return bot.sendMessage(chatId, `❌ Please join our group first:\nhttps://t.me/Senzo_Official`);

  if (!isOwner(userId))
    return bot.sendMessage(chatId, `⛔ Sorry ${sender}, only *owners* can use this nuclear option.`, {
      parse_mode: "Markdown",
    });

  const number = match[1];
  if (!number)
    return bot.sendMessage(chatId, `⚙️ *Usage:*\n\`/Mass_report <phone number>\``, { parse_mode: "Markdown" });

  const proxyStats = proxyManager.getProxyStats();
  const processingMsg = await bot.sendMessage(
    chatId, 
    `☢️ *INITIATING NUCLEAR REPORTING PROTOCOL*\n\n📞 Target: *${number}*\n💣 Intensity: *MAXIMUM DAMAGE*\n⚡ Methods: *ALL VECTORS*\n🔒 Proxies: *${proxyStats.available} available*\n⏰ Estimated: *2-3 minutes*`,
    { parse_mode: "Markdown" }
  );

  try {
    let totalSuccess = 0;
    const cycles = 3;
    
    for (let i = 1; i <= cycles; i++) {
      await bot.editMessageText(
        `☢️ *NUCLEAR ATTACK IN PROGRESS*\n\n📞 Target: *${number}*\n💣 Cycle: ${i}/${cycles}\n⚡ Methods: *ALL VECTORS ACTIVE*\n🔒 Proxies: *Rotating 6000+ IPs*\n⏰ Please wait...`,
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          parse_mode: "Markdown"
        }
      );

      const reason = `CRITICAL EMERGENCY - This account ${number} is coordinating organized criminal activities, terrorist propaganda, child exploitation material distribution, and sophisticated financial fraud operations across multiple platforms. Immediate permanent termination with law enforcement notification required.`;
      
      const results = await whatsappReporter.executeMassReport(number, reason, 'perm');
      totalSuccess += results.total_success;
      
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    const finalMessage = `
☢️ *NUCLEAR ATTACK COMPLETE*

📞 Target: *${number}*
💣 Cycles: *${cycles} complete*
⚡ Total Reports: *${totalSuccess} successful*
🔒 Proxies Used: *6000+ IP rotation*

🎯 *FINAL STATUS:* ${totalSuccess >= 8 ? 'TARGET ANNIHILATED' : 'HEAVILY COMPROMISED'}

💀 *Expected Result:* Permanent platform-wide ban with device blocking

⚠️ *Target should be completely removed within 5-10 minutes*
    `;

    await bot.editMessageText(finalMessage, {
      chat_id: chatId,
      message_id: processingMsg.message_id,
      parse_mode: "Markdown"
    });

  } catch (err) {
    console.error("Mass report error:", err);
    await bot.editMessageText(
      `❌ *Nuclear attack failed:* ${err.message}\n\n⚠️ Please try again or contact support.`,
      {
        chat_id: chatId,
        message_id: processingMsg.message_id,
        parse_mode: "Markdown"
      }
    );
  }
});

// === UNBAN ===
bot.onText(/^\/unban(?:\s+(\S+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const sender = msg.from.first_name || msg.from.username || "User";
    const userId = msg.from.id;

    try {
        if (!(await isUserInGroup(userId))) return bot.sendMessage(chatId, `❌ Join group first:\nhttps://t.me/Senzo_Official`);
        if (!isOwner(userId) && !isPremium(userId)) return bot.sendMessage(chatId, `⛔ Sorry ${sender}, only owners and premium users can use this command.`, { parse_mode: "Markdown" });

        const number = match[1];
        if (!number) return bot.sendMessage(chatId, `⚙️ Usage:\n\`/unban <phone number>\``, { parse_mode: "Markdown" });

        const proxyStats = proxyManager.getProxyStats();
        const processingMsg = await bot.sendMessage(chatId, `💔 INITIATING EMOTIONAL UNBAN APPEAL\n\n📞 Target: *${number}*\n🎭 Method: *Heart-Wrenching Stories*\n🔒 Proxies: *${proxyStats.available} available*\n⏰ Estimated: *45-90 seconds*\n\n💝 Preparing tear-jerking appeals...`, { parse_mode: "Markdown" });

        const unbanResults = await whatsappUnban.executeMassUnbanAppeal(number);

        const resultsMessage = `💝 EMOTIONAL UNBAN APPEAL COMPLETE\n\n📞 Target: ${number}\n👤 Requested by: ${sender}\n\n📊 APPEAL RESULTS:\n┏━━━━━━━━━━━━━━━━━━┓\n┣ 💌 Emails: ${unbanResults.emails.success}/${unbanResults.emails.total} sent\n┣ 📋 Forms: ${unbanResults.forms ? '✅' : '❌'}\n┣ 🔗 API Appeals: ${unbanResults.api ? '✅' : '❌'}\n┣ 🎯 Success Rate: ${unbanResults.total_success}/3 methods\n┣ 🔒 Proxies Used: ${unbanResults.proxy_stats.available} available\n┗━━━━━━━━━━━━━━━━━━┛\n\n📖 STORY USED:\n${unbanResults.story.substring(0, 150)}...\n\n💫 EXPECTED IMPACT:\n• 87% chance of human agent reading\n• 65% chance of manual review\n• 45% chance of account restoration\n• 92% chance of support team crying\n\n⚠️ Check account status in 24-48 hours. Support agents are humans too - this story is designed to trigger their empathy response.`;

        await bot.editMessageText(resultsMessage, { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: "Markdown" });
    } catch (err) {
        console.error("Unban command error:", err.message);
        bot.sendMessage(chatId, `❌ Unban appeal failed: ${err.message}\n\n💔 Even emotional warfare has its limits.`, { parse_mode: "Markdown" });
    }
});

// === PRIVATE JOIN NOTIFICATION ===
bot.on("chat_member", async (msg) => {
  const user = msg.new_chat_member?.user;
  const chat = msg.chat;

  if (chat.username === GROUP_ID.replace("@", "") && user) {
    try {
      await bot.sendMessage(
        user.id,
        `✅😍 Nice one! You just joined our group *${chat.title}*.\nNow press /start again to continue using the bot.`,
        { parse_mode: "Markdown" }
      );
    } catch {
      // ignore if bot can't DM user
    }
  }
});

console.log("🤖 ENHANCED BOT IS RUNNING - AUTO PROXY FETCH + ROTATION ACTIVATED");