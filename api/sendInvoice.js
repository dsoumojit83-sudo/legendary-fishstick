const { Resend } = require("resend");
const PDFDocument = require("pdfkit");
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Fetch order_items for multi-item invoices; falls back to null (single-item mode)
async function fetchOrderItems(orderId) {
    try {
        const { data, error } = await supabase
            .from('order_items')
            .select('service_name, unit_price, quantity, subtotal')
            .eq('order_id', orderId);
        if (error || !data || !data.length) return null;
        return data;
    } catch { return null; }
}

// ─── STRUCTURED LOGGER ───────────────────────────────────────────────────────
// All logs use a prefix so they are easy to filter in the Vercel logs dashboard.
// Format: [ZYRO][sendInvoice][<level>] <timestamp> | order=<id> | <message>
function log(level, orderId, message, extra) {
    const ts = new Date().toISOString();
    const orderTag = orderId ? `order=${orderId}` : 'order=UNKNOWN';
    const prefix = `[ZYRO][sendInvoice][${level}] ${ts} | ${orderTag} |`;
    if (level === 'ERROR' && extra) {
        // Print full error detail so it surfaces in Vercel function logs
        console.error(prefix, message);
        console.error(prefix, 'Error name   :', extra.name);
        console.error(prefix, 'Error message:', extra.message);
        console.error(prefix, 'Error code   :', extra.code);
        console.error(prefix, 'Error stack  :', extra.stack);
        if (extra.response) console.error(prefix, 'SMTP response:', extra.response);
        if (extra.responseCode) console.error(prefix, 'SMTP code    :', extra.responseCode);
    } else if (level === 'ERROR') {
        console.error(prefix, message);
    } else {
        console.log(prefix, message);
    }
}

// ─── TEXT HELPERS ─────────────────────────────────────────────────────────────
// Strip all characters outside printable ASCII (0x20–0x7E).
// Prevents hidden Unicode, emoji, currency symbols (e.g. ¹, ₹, ✅, smart quotes)
// from breaking PDFKit's Helvetica renderer and producing corrupted output.
function sanitizeText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/[^\x20-\x7E]/g, '') // Remove non-printable + non-ASCII
        .trim();
}

// Extract only numeric digits and a single decimal point from raw amount.
// Handles prefixes like '₹', '¹', currency symbols, spaces, or any junk.
// Examples: '¹1' → '1.00' | '₹1000' → '1000.00' | '' → '0.00'
function safeAmount(value) {
    if (value === null || value === undefined) return '0.00';
    const cleaned = String(value).replace(/[^0-9.]/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : '0.00';
}


// ─── HTML ESCAPER for email body ──────────────────────────────────────────────
// sanitizeText() is used for the PDF (strips non-ASCII). For the HTML email body
// we need to escape HTML special chars so that user-supplied names/services can't
// break the email HTML structure or trigger XSS in email clients that render scripts.
function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function sendInvoice(order) {
    const orderId = order?.order_id || 'UNKNOWN';

    log('INFO', orderId, `sendInvoice() called for client: ${order?.client_email}`);

    // Guard: fail fast with a clear error if Resend API key is missing
    if (!process.env.RESEND_API_KEY) {
        const msg = 'CRITICAL: RESEND_API_KEY env var is NOT set. Emails cannot be sent.';
        log('ERROR', orderId, msg);
        throw new Error(`[sendInvoice] ${msg}`);
    }

    log('INFO', orderId, `Using Resend API for email delivery`);

    // Initialize Resend instance
    const resend = new Resend(process.env.RESEND_API_KEY);

    // --- Fetch line items BEFORE Promise (await only works in async scope) ---
    const orderItems = await fetchOrderItems(order.order_id);
    const isMultiItem = orderItems && orderItems.length > 0;
    const invoiceTotal = isMultiItem
        ? orderItems.reduce((sum, item) => sum + (Number(item.subtotal) || Number(item.unit_price) * (item.quantity || 1)), 0)
        : Number(order.amount) || 0;

    return new Promise((resolve, reject) => {
        try {
            // --- Date Formatting Logic ---
            const dateOptions = { month: 'long', day: 'numeric', year: 'numeric' };
            const formattedToday = new Date().toLocaleDateString('en-US', dateOptions);
            let formattedDeadline = "TBD";
            if (order.deadline_date) {
                const [dy, dm, dd] = order.deadline_date.split('-').map(Number);
                formattedDeadline = new Date(dy, dm - 1, dd).toLocaleDateString('en-US', dateOptions);
            }

            // --- 1. PDF GENERATION ENGINE ---
            const doc = new PDFDocument({
                size: "A4",
                margin: 0 // Margins handled manually for full-bleed header
            });

            let buffers = [];
            doc.on("data", buffers.push.bind(buffers));

            // --- CATCH ASYNC STREAM ERRORS ---
            // Without this, if PDFKit silently crashes during generation,
            // the promise hangs forever causing Vercel to timeout (504).
            doc.on("error", (streamErr) => {
                log('ERROR', orderId, 'FAILED: PDFKit stream emitted an error mid-generation.', streamErr);
                reject(streamErr);
            });

            doc.on("end", async () => {
                try {
                    const pdfData = Buffer.concat(buffers);
                    log('INFO', orderId, `PDF generated successfully (${pdfData.length} bytes). Attempting email send...`);

                    // B-15 FIX: Guard against missing or malformed email.
                    // If client_email is absent (e.g. admin-created order with no email),
                    // resolve cleanly instead of crashing Resend with an invalid 'to' field.
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!order.client_email || !emailRegex.test(String(order.client_email).trim())) {
                        log('WARN', orderId, `No valid client_email on order — skipping invoice email.`);
                        return resolve();
                    }

                    // --- 2. EMAIL TRANSMISSION ENGINE ---
                    const { data, error } = await resend.emails.send({
                        from: 'ZyroEditz™ <billing@zyroeditz.xyz>',
                        to: order.client_email,
                        reply_to: 'zyroeditz.official@gmail.com',
                        subject: `Payment Secured: Your ZyroEditz™ Invoice #${order.order_id}`,
                        html: `
                            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #050505; color: #ffffff; border: 1px solid #222222; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                                <div style="background-color: #111111; padding: 40px 30px; text-align: center; border-bottom: 2px solid #ff1a1a;">
                                    <h1 style="margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1px;">Zyro<span style="color: #ff1a1a;">Editz</span>&trade;</h1>
                                    <p style="margin: 5px 0 0; color: #888888; font-size: 10px; text-transform: uppercase; letter-spacing: 4px;">Speed. Motion. Precision.</p>
                                </div>
                                
                                <div style="padding: 40px 30px;">
                                    <h2 style="margin-top: 0; color: #ffffff; font-size: 24px;">Payment Secured. ⚡</h2>
                                    <p style="color: #cccccc; font-size: 15px; line-height: 1.6;">Hi <strong>${escapeHtml(order.client_name)}</strong>,</p>
                                    <p style="color: #cccccc; font-size: 15px; line-height: 1.6;">Your payment has been successfully processed and your project is officially in our pipeline. Your official invoice is attached to this email as a PDF.</p>
                                    
                                    <div style="background-color: #111111; border: 1px solid #333333; border-radius: 8px; padding: 20px; margin: 30px 0;">
                                        <table style="width: 100%; border-collapse: collapse;">
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order ID</td>
                                                <td style="padding: 10px 0; color: #ff1a1a; font-weight: bold; text-align: right; font-family: monospace; font-size: 14px;">${order.order_id}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #222222;">Service</td>
                                                <td style="padding: 10px 0; color: #ffffff; font-weight: bold; text-align: right; border-top: 1px solid #222222; font-size: 14px;">${escapeHtml(order.service)}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #222222;">Total Paid</td>
                                                <td style="padding: 10px 0; color: #ffffff; font-weight: bold; text-align: right; border-top: 1px solid #222222; font-size: 14px;">₹${order.amount}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #222222;">Est. Delivery</td>
                                                <td style="padding: 10px 0; color: #ffffff; font-weight: bold; text-align: right; border-top: 1px solid #222222; font-size: 14px;">${formattedDeadline}</td>
                                            </tr>
                                        </table>
                                    </div>

                                    <h3 style="color: #ffffff; font-size: 16px; margin-bottom: 10px; border-left: 3px solid #ff1a1a; padding-left: 10px;">What happens next?</h3>
                                    <p style="color: #cccccc; font-size: 14px; line-height: 1.6; margin-top: 0;">If you haven't already, please upload your raw footage and assets via the Secure Vault link provided after checkout. Our team will begin the edit immediately once the assets are received.</p>
                                </div>

                                <div style="background-color: #0a0a0a; padding: 25px 30px; text-align: center; border-top: 1px solid #1a1a1a;">
                                    <p style="margin: 0; color: #666666; font-size: 12px;">© ${new Date().getFullYear()} ZyroEditz&trade;. All rights reserved.</p>
                                    <p style="margin: 5px 0 0; color: #444444; font-size: 11px;">If you have any questions, reply to this email or contact <a href="mailto:zyroeditz.official@gmail.com" style="color: #ff1a1a; text-decoration: none;">zyroeditz.official@gmail.com</a>.</p>
                                </div>
                            </div>
                        `,
                        attachments: [
                            {
                                filename: `ZyroEditz_Invoice_${order.order_id}.pdf`,
                                content: pdfData
                            }
                        ]
                    });

                    if (error) {
                        log('ERROR', orderId, 'FAILED: resend.emails.send() returned an error.', error);
                        return reject(error);
                    }

                    log('INFO', orderId, `SUCCESS: Invoice email delivered to ${order.client_email} via Resend. ID: ${data?.id}`);



                    resolve();
                } catch (err) {
                    log('ERROR', orderId, 'FAILED: Email delivery threw an error.', err);
                    reject(err);
                }
            });

            // --- 3. DRAWING THE PDF ---

            // ── Full-bleed black header ──
            doc.rect(0, 0, 595.28, 140).fill('#050505');

            // Brand logo (left): "Zyro" white, "Editz" red
            doc.fillColor('#ffffff').fontSize(42).font('Helvetica-Bold').text('Zyro', 50, 45, { continued: true })
                .fillColor('#ff1a1a').text('Editz', { continued: true })
                .fillColor('#ffffff').fontSize(20).text('\u2122', { continued: false });
            doc.fillColor('#888888').fontSize(10).font('Helvetica').text('Speed. Motion. Precision.', 50, 92, { letterSpacing: 4 });

            // Invoice title (right)
            doc.fillColor('#ff1a1a').fontSize(32).font('Helvetica-Bold').text('INVOICE', 0, 45, { align: 'right', width: 545 });
            doc.fillColor('#cccccc').fontSize(12).font('Courier').text(`#${sanitizeText(order.order_id)}`, 0, 82, { align: 'right', width: 545 }); // UPDATED
            doc.fillColor('#cccccc').font('Helvetica').fontSize(12).text(`Date: ${formattedToday}`, 0, 100, { align: 'right', width: 545 });

            // Red accent border under header
            doc.rect(0, 140, 595.28, 4).fill('#ff1a1a');

            // ── BILLED TO ──
            doc.rect(50, 165, 220, 98).fill('#f8f8f8');
            doc.rect(50, 165, 4, 98).fill('#ff1a1a');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('BILLED TO:', 64, 175);
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(sanitizeText(order.client_name) || 'Zyro Client', 64, 193); // UPDATED
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text(sanitizeText(order.client_email), 64, 212); // UPDATED
            doc.fillColor('#555555').fontSize(12).text(sanitizeText(order.client_phone), 64, 228); // UPDATED

            // ── PAYABLE TO ──
            doc.rect(325, 165, 220, 98).fill('#f8f8f8');
            doc.rect(541, 165, 4, 98).fill('#050505');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('PAYABLE TO:', 325, 175, { width: 212, align: 'right' });
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('ZyroEditz(TM) Studio', 325, 193, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text('+91 8900229800', 325, 212, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).text('zyroeditz.official@gmail.com', 325, 228, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).text('Malda, West Bengal, India', 325, 244, { width: 212, align: 'right' });

            // ── TABLE HEADER ──
            doc.rect(50, 270, 495, 36).fill('#050505');
            doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold')
                .text('DESCRIPTION', 65, 283)
                .text('EST. DELIVERY', 295, 283, { width: 120, align: 'center' })
                .text('AMOUNT', 430, 283, { width: 100, align: 'right' });

            // ── TABLE ROW(S) — multi-item if order_items exist, else single-item fallback ──
            let rowY = 316;
            const ROW_HEIGHT = 58;
            if (isMultiItem) {
                orderItems.forEach((item, i) => {
                    const lineTotal = Number(item.subtotal) || Number(item.unit_price) * (item.quantity || 1);
                    doc.fillColor('#000000').fontSize(13).font('Helvetica-Bold').text(`${sanitizeText(item.service_name)}`, 65, rowY + 7);
                    doc.fillColor('#666666').fontSize(9).font('Helvetica').text(`Qty: ${item.quantity || 1}`, 65, rowY + 24);
                    doc.fillColor('#000000').fontSize(13).font('Helvetica').text(formattedDeadline, 295, rowY + 13, { width: 120, align: 'center' });
                    doc.fillColor('#000000').fontSize(13).text(`Rs.${safeAmount(lineTotal)}`, 430, rowY + 13, { width: 100, align: 'right' });
                    if (i < orderItems.length - 1) {
                        doc.moveTo(50, rowY + ROW_HEIGHT - 2).lineTo(545, rowY + ROW_HEIGHT - 2).lineWidth(0.5).strokeColor('#eeeeee').stroke();
                    }
                    rowY += ROW_HEIGHT;
                });
            } else {
                doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(`${sanitizeText(order.service)} Package`, 65, rowY + 7);
                doc.fillColor('#666666').fontSize(10).font('Helvetica')
                    .text('Premium cinematic editing and post-production. Includes 1 free revision.', 65, rowY + 25, { width: 220 });
                doc.fillColor('#000000').fontSize(14).font('Helvetica').text(formattedDeadline, 295, rowY + 15, { width: 120, align: 'center' });
                doc.fillColor('#000000').fontSize(14).text(`Rs.${safeAmount(order.amount)}`, 430, rowY + 15, { width: 100, align: 'right' });
                rowY += ROW_HEIGHT;
            }

            // Row divider
            const dividerY = rowY + 6;
            doc.moveTo(50, dividerY).lineTo(545, dividerY).lineWidth(1).strokeColor('#eeeeee').stroke();

            // ── TOTAL ROW ──
            const totalY = dividerY + 12;
            doc.rect(50, totalY, 495, 44).fill('#f8f8f8');
            doc.moveTo(50, totalY + 44).lineTo(545, totalY + 44).lineWidth(2).strokeColor('#050505').stroke();
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold')
                .text('TOTAL PAID:', 50, totalY + 15, { width: 370, align: 'right' });
            doc.fillColor('#ff1a1a').fontSize(18).font('Helvetica-Bold')
                .text(`Rs.${safeAmount(invoiceTotal)}`, 390, totalY + 11, { width: 150, align: 'right' });

            // ── PAYMENT STATUS ──
            const statusY = totalY + 68;
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Bold').text('PAYMENT STATUS', 50, statusY);
            doc.fillColor('#22c55e').fontSize(18).font('Helvetica-Bold').text('Paid in Full', 50, statusY + 18, { continued: false });
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Oblique')
                .text('Thanks for giving us a chance to serve you.', 50, statusY + 42);

            // ── FOOTER ──
            doc.moveTo(50, 750).lineTo(545, 750).lineWidth(1).strokeColor('#cccccc').stroke();
            doc.fillColor('#888888').fontSize(10).font('Helvetica')
                .text('This is a computer-generated document. No signature is required.', 50, 766, { align: 'center', width: 495 });
            doc.font('Helvetica-Bold')
                .text('ZyroEditz(TM) | Cinematic Editing & Motion Graphics', 50, 782, { align: 'center', width: 495 });

            log('INFO', orderId, 'PDF build complete. Waiting for doc.end() to flush buffers...');
            doc.end();

        } catch (err) {
            log('ERROR', orderId, 'FAILED: PDF generation threw an error before doc.end().', err);
            reject(err);
        }
    });
}

// ─── ON-DEMAND PDF BUILDER ────────────────────────────────────────────────────
// Generates the identical branded invoice PDF as a Buffer (no email).
// Used by chat.js (client bill download) and admin-data.js (admin bill download).
// Re-uses sanitizeText(), safeAmount(), and the same PDFKit layout as above.
async function buildPdfBuffer(order) {
    return new Promise((resolve, reject) => {
        try {
            const doc  = new PDFDocument({ size: 'A4', margin: 0 });
            const bufs = [];
            doc.on('data',  b  => bufs.push(b));
            doc.on('end',   () => resolve(Buffer.concat(bufs)));
            doc.on('error', reject);

            const dateOpts = { month: 'long', day: 'numeric', year: 'numeric' };
            const today    = new Date().toLocaleDateString('en-US', dateOpts);
            let   deadline = 'TBD';
            if (order.deadline_date) {
                const [dy, dm, dd] = order.deadline_date.split('-').map(Number);
                deadline = new Date(dy, dm - 1, dd).toLocaleDateString('en-US', dateOpts);
            }

            // ── Header ────────────────────────────────────────────────────────
            doc.rect(0, 0, 595.28, 140).fill('#050505');
            doc.fillColor('#ffffff').fontSize(42).font('Helvetica-Bold').text('Zyro', 50, 45, { continued: true })
               .fillColor('#ff1a1a').text('Editz', { continued: true })
               .fillColor('#ffffff').fontSize(20).text('\u2122', { continued: false });
            doc.fillColor('#888888').fontSize(10).font('Helvetica').text('Speed. Motion. Precision.', 50, 92, { letterSpacing: 4 });
            doc.fillColor('#ff1a1a').fontSize(32).font('Helvetica-Bold').text('INVOICE', 0, 45, { align: 'right', width: 545 });
            doc.fillColor('#cccccc').fontSize(12).font('Courier').text(`#${sanitizeText(order.order_id)}`, 0, 82, { align: 'right', width: 545 });
            doc.fillColor('#cccccc').font('Helvetica').fontSize(12).text(`Date: ${today}`, 0, 100, { align: 'right', width: 545 });
            doc.rect(0, 140, 595.28, 4).fill('#ff1a1a');

            // ── Billed To ─────────────────────────────────────────────────────
            doc.rect(50, 165, 220, 98).fill('#f8f8f8');
            doc.rect(50, 165, 4, 98).fill('#ff1a1a');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('BILLED TO:', 64, 175);
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(sanitizeText(order.client_name) || 'Zyro Client', 64, 193);
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text(sanitizeText(order.client_email || ''), 64, 212);
            doc.fillColor('#555555').fontSize(12).text(sanitizeText(order.client_phone || ''), 64, 228);

            // ── Payable To ────────────────────────────────────────────────────
            doc.rect(325, 165, 220, 98).fill('#f8f8f8');
            doc.rect(541, 165, 4, 98).fill('#050505');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('PAYABLE TO:', 325, 175, { width: 212, align: 'right' });
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('ZyroEditz(TM) Studio', 325, 193, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text('+91 8900229800', 325, 212, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).text('zyroeditz.official@gmail.com', 325, 228, { width: 212, align: 'right' });
            doc.fillColor('#555555').fontSize(12).text('Malda, West Bengal, India', 325, 244, { width: 212, align: 'right' });

            // ── Table Header ──────────────────────────────────────────────────
            doc.rect(50, 270, 495, 36).fill('#050505');
            doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold')
               .text('DESCRIPTION', 65, 283)
               .text('EST. DELIVERY', 295, 283, { width: 120, align: 'center' })
               .text('AMOUNT', 430, 283, { width: 100, align: 'right' });

            // ── Table Row ─────────────────────────────────────────────────────
            const rowY = 316;
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold')
               .text(`${sanitizeText(order.service)} Package`, 65, rowY + 7);
            doc.fillColor('#666666').fontSize(10).font('Helvetica')
               .text('Premium cinematic editing and post-production. Includes 1 free revision.', 65, rowY + 25, { width: 220 });
            doc.fillColor('#000000').fontSize(14).font('Helvetica').text(deadline, 295, rowY + 15, { width: 120, align: 'center' });
            doc.fillColor('#000000').fontSize(14).text(`Rs.${safeAmount(order.amount)}`, 430, rowY + 15, { width: 100, align: 'right' });

            // ── Total ─────────────────────────────────────────────────────────
            const divY = rowY + 64;
            const totY = divY + 12;
            doc.moveTo(50, divY).lineTo(545, divY).lineWidth(1).strokeColor('#eeeeee').stroke();
            doc.rect(50, totY, 495, 44).fill('#f8f8f8');
            doc.moveTo(50, totY + 44).lineTo(545, totY + 44).lineWidth(2).strokeColor('#050505').stroke();
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('TOTAL PAID:', 50, totY + 15, { width: 370, align: 'right' });
            doc.fillColor('#ff1a1a').fontSize(18).font('Helvetica-Bold').text(`Rs.${safeAmount(order.amount)}`, 390, totY + 11, { width: 150, align: 'right' });

            // ── Payment Status ────────────────────────────────────────────────
            const stY = totY + 68;
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Bold').text('PAYMENT STATUS', 50, stY);
            doc.fillColor('#22c55e').fontSize(18).font('Helvetica-Bold').text('Paid in Full', 50, stY + 18);
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Oblique').text('Thanks for giving us a chance to serve you.', 50, stY + 42);

            // ── Footer ────────────────────────────────────────────────────────
            doc.moveTo(50, 750).lineTo(545, 750).lineWidth(1).strokeColor('#cccccc').stroke();
            doc.fillColor('#888888').fontSize(10).font('Helvetica')
               .text('This is a computer-generated document. No signature is required.', 50, 766, { align: 'center', width: 495 });
            doc.font('Helvetica-Bold')
               .text('ZyroEditz(TM) | Cinematic Editing & Motion Graphics', 50, 782, { align: 'center', width: 495 });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = sendInvoice;
module.exports.buildPdfBuffer = buildPdfBuffer;

