const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

async function sendInvoice(order) {
    // Guard: fail fast with a clear error if email credentials are missing
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error('[sendInvoice] EMAIL_USER or EMAIL_PASS not configured in environment variables.');
    }

    // Create transporter INSIDE the function so it reads live env vars on every call.
    // If created at module load (top-level), Vercel serverless may not have env vars yet.
    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS   // Must be a Gmail App Password, NOT your real password
        }
    });

    // Verify SMTP connection before attempting to build the PDF.
    // This will throw immediately with a clear error if credentials are wrong.
    await transporter.verify();

    return new Promise((resolve, reject) => {
        try {
            // --- Date Formatting Logic ---
            const dateOptions = { month: 'long', day: 'numeric', year: 'numeric' };
            const formattedToday = new Date().toLocaleDateString('en-US', dateOptions);
            let formattedDeadline = "TBD";
            if (order.deadline_date) {
                formattedDeadline = new Date(order.deadline_date).toLocaleDateString('en-US', dateOptions);
            }

            // --- 1. PDF GENERATION ENGINE ---
            const doc = new PDFDocument({
                size: "A4",
                margin: 0 // Margins handled manually for full-bleed header
            });

            let buffers = [];
            doc.on("data", buffers.push.bind(buffers));

            doc.on("end", async () => {
                try {
                    const pdfData = Buffer.concat(buffers);

                    // --- 2. EMAIL TRANSMISSION ENGINE ---
                    await transporter.sendMail({
                        from: `"ZyroEditz" <${process.env.EMAIL_USER}>`,
                        to: order.client_email,
                        subject: `Payment Secured: Your ZyroEditz Invoice #${order.order_id}`,
                        html: `
                            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #050505; color: #ffffff; border: 1px solid #222222; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                                <div style="background-color: #111111; padding: 40px 30px; text-align: center; border-bottom: 2px solid #ff1a1a;">
                                    <h1 style="margin: 0; font-size: 32px; font-weight: 900; letter-spacing: -1px;">Zyro<span style="color: #ff1a1a;">Editz</span></h1>
                                    <p style="margin: 5px 0 0; color: #888888; font-size: 10px; text-transform: uppercase; letter-spacing: 4px;">Speed. Motion. Precision.</p>
                                </div>
                                
                                <div style="padding: 40px 30px;">
                                    <h2 style="margin-top: 0; color: #ffffff; font-size: 24px;">Payment Secured. ⚡</h2>
                                    <p style="color: #cccccc; font-size: 15px; line-height: 1.6;">Hi <strong>${order.client_name}</strong>,</p>
                                    <p style="color: #cccccc; font-size: 15px; line-height: 1.6;">Your payment has been successfully processed and your project is officially in our pipeline. Your official invoice is attached to this email as a PDF.</p>
                                    
                                    <div style="background-color: #111111; border: 1px solid #333333; border-radius: 8px; padding: 20px; margin: 30px 0;">
                                        <table style="width: 100%; border-collapse: collapse;">
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Order ID</td>
                                                <td style="padding: 10px 0; color: #ff1a1a; font-weight: bold; text-align: right; font-family: monospace; font-size: 14px;">${order.order_id}</td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0; color: #888888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; border-top: 1px solid #222222;">Service</td>
                                                <td style="padding: 10px 0; color: #ffffff; font-weight: bold; text-align: right; border-top: 1px solid #222222; font-size: 14px;">${order.service}</td>
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
                                    <p style="margin: 0; color: #666666; font-size: 12px;">© ${new Date().getFullYear()} ZyroEditz. All rights reserved.</p>
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

                    console.log(`✅ Premium Invoice sent to ${order.client_email}`);
                    resolve();
                } catch (err) {
                    console.error("❌ Email send error:", err);
                    reject(err);
                }
            });

            // --- 3. DRAWING THE PDF ---

            // ── Full-bleed black header ──
            doc.rect(0, 0, 595.28, 140).fill('#050505');

            // Brand logo (left): "Zyro" white, "Editz" red
            doc.fillColor('#ffffff').fontSize(42).font('Helvetica-Bold').text('Zyro', 50, 45, {continued: true})
               .fillColor('#ff1a1a').text('Editz');
            doc.fillColor('#888888').fontSize(10).font('Helvetica').text('Speed. Motion. Precision.', 50, 92, {letterSpacing: 4});

            // Invoice title (right)
            doc.fillColor('#ff1a1a').fontSize(32).font('Helvetica-Bold').text('INVOICE', 0, 45, {align: 'right', width: 545});
            doc.fillColor('#cccccc').fontSize(12).font('Courier').text(`#${order.order_id}`, 0, 82, {align: 'right', width: 545});
            doc.fillColor('#cccccc').font('Helvetica').fontSize(12).text(`Date: ${formattedToday}`, 0, 100, {align: 'right', width: 545});

            // Red accent border under header
            doc.rect(0, 140, 595.28, 4).fill('#ff1a1a');

            // ── BILLED TO: #f8f8f8 box with 4px #ff1a1a left border ──
            doc.rect(50, 165, 220, 82).fill('#f8f8f8');
            doc.rect(50, 165, 4, 82).fill('#ff1a1a');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('BILLED TO:', 64, 175);
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(order.client_name || 'Zyro Client', 64, 193);
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text(order.client_email, 64, 212);
            doc.fillColor('#555555').fontSize(12).text(order.client_phone, 64, 228);

            // ── PAYABLE TO: #f8f8f8 box with 4px #050505 right border, text right-aligned ──
            doc.rect(325, 165, 220, 82).fill('#f8f8f8');
            doc.rect(541, 165, 4, 82).fill('#050505');
            doc.fillColor('#888888').fontSize(11).font('Helvetica-Bold').text('PAYABLE TO:', 325, 175, {width: 212, align: 'right'});
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('ZyroEditz Studio', 325, 193, {width: 212, align: 'right'});
            doc.fillColor('#555555').fontSize(12).font('Helvetica').text('zyroeditz.official@gmail.com', 325, 212, {width: 212, align: 'right'});
            doc.fillColor('#555555').fontSize(12).text('Malda, West Bengal, India', 325, 228, {width: 212, align: 'right'});

            // ── TABLE HEADER: black bar ──
            doc.rect(50, 270, 495, 36).fill('#050505');
            doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold')
               .text('DESCRIPTION', 65, 283)
               .text('EST. DELIVERY', 295, 283, {width: 120, align: 'center'})
               .text('AMOUNT', 430, 283, {width: 100, align: 'right'});

            // ── TABLE ROW: bold service name + grey subtitle ──
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(`${order.service} Package`, 65, 323);
            doc.fillColor('#666666').fontSize(10).font('Helvetica')
               .text('Premium cinematic editing and post-production. Includes 1 free revision.', 65, 341, {width: 220});
            // Delivery date + ₹ amount aligned to the service name row
            doc.fillColor('#000000').fontSize(14).font('Helvetica').text(formattedDeadline, 295, 331, {width: 120, align: 'center'});
            doc.fillColor('#000000').fontSize(14).text(`\u20B9${Number(order.amount).toFixed(2)}`, 430, 331, {width: 100, align: 'right'});

            // Row divider
            doc.moveTo(50, 382).lineTo(545, 382).lineWidth(1).strokeColor('#eeeeee').stroke();

            // ── TOTAL ROW: #f8f8f8 bg, "TOTAL PAID:" label, red ₹ amount ──
            doc.rect(50, 394, 495, 44).fill('#f8f8f8');
            doc.moveTo(50, 438).lineTo(545, 438).lineWidth(2).strokeColor('#050505').stroke();
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold')
               .text('TOTAL PAID:', 50, 409, {width: 455, align: 'right'});
            doc.fillColor('#ff1a1a').fontSize(18).font('Helvetica-Bold')
               .text(`\u20B9${Number(order.amount).toFixed(2)}`, 390, 405, {width: 150, align: 'right'});

            // ── PAYMENT STATUS ──
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Bold').text('PAYMENT STATUS', 50, 502);
            doc.fillColor('#22c55e').fontSize(18).font('Helvetica-Bold').text('Paid in Full \u2705', 50, 520);
            doc.fillColor('#888888').fontSize(12).font('Helvetica-Oblique')
               .text('Thanks for giving us a chance to serve you.', 50, 544);

            // ── FOOTER ──
            doc.moveTo(50, 750).lineTo(545, 750).lineWidth(1).strokeColor('#cccccc').stroke();
            doc.fillColor('#888888').fontSize(10).font('Helvetica')
               .text('This is a computer-generated document. No signature is required.', 50, 766, {align: 'center', width: 495});
            doc.font('Helvetica-Bold')
               .text('ZyroEditz | Cinematic Editing & Motion Graphics', 50, 782, {align: 'center', width: 495});

            doc.end();

        } catch (err) {
            reject(err);
        }
    });
}

module.exports = sendInvoice;
