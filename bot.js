const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

// Determine Puppeteer executable path if the full `puppeteer` package is installed.
let puppeteerExecPath;
try {
    puppeteerExecPath = require('puppeteer').executablePath();
} catch (e) {
    puppeteerExecPath = undefined;
}

if (!puppeteerExecPath) {
    console.warn('No Puppeteer executable found via `puppeteer.executablePath()`; ensure Chrome/Chromium is installed in the environment or set an executable path.');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: puppeteerExecPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Ensure temp directory exists
if (!fs.existsSync('temp')) {
    fs.mkdirSync('temp');
}

client.on('qr', qr => {
    console.log('📱 Scan QR Code:');
    qrcode.generate(qr, { small: true });
    
    // Also output QR code as text for environments where terminal QR doesn't work well
    console.log('\n📱 QR Code as text (for copy/paste into QR scanner):');
    console.log(qr);
    console.log('\n'); // Add some spacing
});

client.on('ready', () => {
    console.log('✅ BOT READY');
    console.log('Available commands:');
    console.log('.sticker <text> - Reply to an image to add text and convert to sticker');
    console.log('.ping - Test if bot is working');
});

client.on('message', async msg => {
    try {
        // COMMAND: .ping
        if (msg.body === '.ping') {
            await msg.reply('🏓 Pong!');
        }

        // AUTO: convert incoming images to stickers (skip dot-commands)
        if (!(typeof msg.body === 'string' && msg.body.startsWith('.'))) {
            // Accept images sent directly or images in quoted messages
            let mediaSource = null;
            if (msg.hasMedia) {
                mediaSource = msg;
            } else if (msg.hasQuotedMsg) {
                const quoted = await msg.getQuotedMessage();
                if (quoted && quoted.hasMedia) mediaSource = quoted;
            }

            if (mediaSource) {
                console.log('Auto-convert image to sticker:', { from: msg.from, isQuoted: mediaSource.id._serialized !== msg.id._serialized });
                try {
                    const media = await mediaSource.downloadMedia();
                    if (!media || !media.mimetype || !media.mimetype.startsWith('image/')) {
                        return; // ignore non-image media
                    }

                    const buffer = Buffer.from(media.data, 'base64');
                    const image = await Jimp.read(buffer);

                    // Ensure square sticker
                    image.cover(512, 512);

                    // Prepare optional bottom text from the message (caption/body)
                    let stickerText = '';
                    try {
                        if (mediaSource && typeof mediaSource.body === 'string' && !mediaSource.body.startsWith('.')) {
                            stickerText = mediaSource.body.trim();
                        }
                    } catch (e) {
                        stickerText = '';
                    }

                    // If text present, render it at the bottom with font sizing
                    // Also detect emojis and render them above the text using Twemoji PNGs
                    if (stickerText) {
                        // extract emojis and split text into tokens (text runs and emoji runs)
                        const emojiRegex = /([\u{1F300}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}])/gu;
                        const tokens = [];
                        let lastIndex = 0;
                        let me;
                        while ((me = emojiRegex.exec(stickerText)) !== null) {
                            if (me.index > lastIndex) {
                                tokens.push({ type: 'text', text: stickerText.slice(lastIndex, me.index) });
                            }
                            tokens.push({ type: 'emoji', text: me[0] });
                            lastIndex = emojiRegex.lastIndex;
                        }
                        if (lastIndex < stickerText.length) {
                            tokens.push({ type: 'text', text: stickerText.slice(lastIndex) });
                        }

                        // load emoji images for any emoji tokens
                        const emojiImagesMap = new Map();
                        for (const t of tokens) {
                            if (t.type === 'emoji' && !emojiImagesMap.has(t.text)) {
                                try {
                                    const codepoints = Array.from(t.text).map(c => c.codePointAt(0).toString(16)).join('-');
                                    const url = `https://twemoji.maxcdn.com/v/latest/72x72/${codepoints}.png`;
                                    const emImg = await Jimp.read(url);
                                    emojiImagesMap.set(t.text, emImg);
                                } catch (e) {
                                    emojiImagesMap.set(t.text, null);
                                }
                            }
                        }
                        const maxWidth = 492; // 512 minus padding
                        const availableHeight = 400; // space we can use for centered text
                        const padding = 8;

                        // Try fonts from medium to small (reduce size slightly)
                        const fontSizes = [Jimp.FONT_SANS_64_WHITE, Jimp.FONT_SANS_32_WHITE, Jimp.FONT_SANS_16_WHITE];
                        const fontBlackSizes = [Jimp.FONT_SANS_64_BLACK, Jimp.FONT_SANS_32_BLACK, Jimp.FONT_SANS_16_BLACK];
                        let whiteFont = null;
                        let blackFont = null;
                        let chosenSize = 32;

                        for (let i = 0; i < fontSizes.length; i++) {
                            try {
                                const f = await Jimp.loadFont(fontSizes[i]);
                                const h = Jimp.measureTextHeight(f, stickerText, maxWidth);
                                whiteFont = f;
                                blackFont = await Jimp.loadFont(fontBlackSizes[i]);
                                chosenSize = (fontSizes[i] === Jimp.FONT_SANS_128_WHITE) ? 128 : (fontSizes[i] === Jimp.FONT_SANS_64_WHITE) ? 64 : 32;
                                if (h <= availableHeight) break;
                            } catch (e) {
                                whiteFont = null;
                                blackFont = null;
                            }
                        }

                        if (!whiteFont) {
                            whiteFont = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
                            blackFont = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
                            chosenSize = 32;
                        }

                        // Build wrapped lines from tokens (respect emoji widths)
                        const lines = [];
                        let currentLine = [];
                        let currentWidth = 0;
                        const emojiWidth = chosenSize; // treat emoji width as approx font size

                        const pushLine = () => {
                            if (currentLine.length) {
                                lines.push(currentLine);
                                currentLine = [];
                                currentWidth = 0;
                            }
                        };

                        for (const t of tokens) {
                            if (t.type === 'text') {
                                // split text token into words keeping spaces
                                const parts = t.text.split(/(\s+)/);
                                for (const part of parts) {
                                    if (!part) continue;
                                    const partWidth = Jimp.measureText(whiteFont, part);
                                    if (currentWidth + partWidth <= maxWidth || currentLine.length === 0) {
                                        currentLine.push({ type: 'text', text: part, width: partWidth });
                                        currentWidth += partWidth;
                                    } else {
                                        pushLine();
                                        currentLine.push({ type: 'text', text: part, width: partWidth });
                                        currentWidth += partWidth;
                                    }
                                }
                            } else if (t.type === 'emoji') {
                                const ew = emojiImagesMap.get(t.text) ? emojiWidth : 0;
                                if (currentWidth + ew <= maxWidth || currentLine.length === 0) {
                                    currentLine.push({ type: 'emoji', text: t.text, width: ew });
                                    currentWidth += ew;
                                } else {
                                    pushLine();
                                    currentLine.push({ type: 'emoji', text: t.text, width: ew });
                                    currentWidth += ew;
                                }
                            }
                        }
                        pushLine();

                        // Compute line spacing. Allow overlap if needed instead of shrinking font too small
                        const approxLineHeight = chosenSize; // approximate
                        let totalHeight = approxLineHeight * lines.length;
                        let lineSpacing = approxLineHeight; // y increment
                        if (totalHeight > availableHeight && lines.length > 1) {
                            // compute required overlap per gap
                            const excess = totalHeight - availableHeight;
                            const overlapPerGap = Math.ceil(excess / (lines.length - 1));
                            lineSpacing = Math.max(10, approxLineHeight - overlapPerGap); // do not go below 10px spacing
                            totalHeight = lineSpacing * (lines.length - 1) + approxLineHeight;
                        }

                        // Account for emoji row height if emoji images were loaded
                        let emojiRowHeight = 0;
                        let emojiImages = [];
                        if (typeof emojiImagesMap !== 'undefined' && emojiImagesMap.size > 0) {
                            for (const img of emojiImagesMap.values()) {
                                if (img) emojiImages.push(img);
                            }
                            if (emojiImages.length) emojiRowHeight = 64; // we'll scale emojis to 64px height
                        }

                        // Place text at bottom (centered horizontally), above any bottom padding
                        let startY = Math.round(512 - totalHeight - padding);
                        // If emojis exist, shift text down a bit so emojis sit above text
                        if (emojiRowHeight) startY -= emojiRowHeight + 6;
                        if (startY < padding) startY = padding;
                        const centerX = padding;

                        // Draw each tokenized line centered horizontally, rendering text and emojis inline
                        const offsets = [[-2,0],[2,0],[0,-2],[0,2],[-2,-2],[-2,2],[2,-2],[2,2]];
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            // compute line width
                            const lineWidth = line.reduce((s, tk) => s + (tk.width || 0), 0);
                            let x = Math.round((512 - lineWidth) / 2);
                            const y = startY + i * lineSpacing;

                            for (const tk of line) {
                                if (tk.type === 'text') {
                                    // draw outline for text by printing blackFont at offsets
                                    for (const [dx, dy] of offsets) {
                                        image.print(blackFont, x + dx, y + dy, tk.text);
                                    }
                                    // print white text
                                    image.print(whiteFont, x, y, tk.text);
                                    x += tk.width;
                                } else if (tk.type === 'emoji') {
                                    const emImg = emojiImagesMap.get(tk.text);
                                    if (emImg) {
                                        try {
                                            const emClone = emImg.clone();
                                            emClone.contain(emojiWidth, emojiWidth);
                                            image.composite(emClone, x, y, { mode: Jimp.BLEND_SOURCE_OVER, opacitySource: 1 });
                                            x += emojiWidth;
                                        } catch (e) {
                                            x += emojiWidth;
                                        }
                                    } else {
                                        x += emojiWidth;
                                    }
                                }
                            }
                        }

                        // (Removed extra centered emoji composite to avoid duplicate emojis)
                    }

                    const tempPath = path.join('temp', `sticker_${Date.now()}.png`);
                    await image.writeAsync(tempPath);

                    const stickerBuffer = fs.readFileSync(tempPath);
                    const sticker = new MessageMedia('image/png', stickerBuffer.toString('base64'), 'sticker.png');

                    await client.sendMessage(msg.from, sticker, {
                        sendMediaAsSticker: true,
                        stickerAuthor: "KaiStick",
                        stickerName: "sticker"
                    });

                    fs.unlinkSync(tempPath);
                    console.log(`✅ Auto-sticker sent to ${msg.from}`);
                } catch (err) {
                    console.error('Error auto-creating sticker:', err);
                }
            }
        }

        // COMMAND: .help
        if (msg.body === '.help') {
            const helpText = `📌 *WhatsApp Sticker Bot Commands*\n\n` +
                `.ping - Test bot\n` +
                `.sticker <text> - Convert image to sticker (reply to image)\n` +
                `.help - Show this message`;
            await msg.reply(helpText);
        }
    } catch (err) {
        console.error('Error handling message:', err);
    }
});

client.on('disconnected', (reason) => {
    console.log('🔴 Bot disconnected:', reason);
});

client.initialize();