const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

// Create transporter once
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendInvoice(order) {
    // Guard: fail fast with a clear error if email credentials are missing
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        throw new Error('[sendInvoice] EMAIL_USER or EMAIL_PASS not configured in environment variables.');
    }

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
            
            // Full Bleed Black Header
            doc.rect(0, 0, 595.28, 140).fill('#050505');
            
            // Brand Logo (Left)
            doc.fillColor('#ffffff').fontSize(42).font('Helvetica-Bold').text('Zyro', 50, 45, {continued: true})
               .fillColor('#ff1a1a').text('Editz');
            doc.fillColor('#888888').fontSize(10).font('Helvetica').text('SPEED. MOTION. PRECISION.', 50, 90, {letterSpacing: 4});

            // Invoice Title (Right)
            doc.fillColor('#ff1a1a').fontSize(32).font('Helvetica-Bold').text('INVOICE', 0, 45, {align: 'right', width: 545});
            doc.fillColor('#cccccc').fontSize(12).font('Courier').text(`#${order.order_id}`, 0, 80, {align: 'right', width: 545});
            doc.fillColor('#cccccc').font('Helvetica').fontSize(12).text(`Date: ${formattedToday}`, 0, 100, {align: 'right', width: 545});

            // Red Border under header
            doc.rect(0, 140, 595.28, 4).fill('#ff1a1a');

            // Billed To Section (Left)
            doc.fontSize(11).fillColor('#888888').font('Helvetica-Bold').text('BILLED TO:', 50, 190);
            doc.fontSize(14).fillColor('#000000').text(order.client_name || "Zyro Client", 50, 210);
            doc.fontSize(12).font('Helvetica').fillColor('#555555').text(order.client_email, 50, 230);
            doc.text(order.client_phone, 50, 245);

            // Payable To Section (Right)
            doc.fontSize(11).fillColor('#888888').font('Helvetica-Bold').text('PAYABLE TO:', 350, 190);
            doc.fontSize(14).fillColor('#000000').text('ZyroEditz Studio', 350, 210);
            doc.fontSize(12).font('Helvetica').fillColor('#555555').text('zyroeditz.official@gmail.com', 350, 230);
            doc.text('Malda, West Bengal, India', 350, 245);

            // Table Header Background
            doc.rect(50, 290, 495, 30).fill('#050505');
            
            // Table Headers
            doc.fillColor('#ffffff').fontSize(12).font('Helvetica-Bold')
               .text('DESCRIPTION', 65, 300)
               .text('EST. DELIVERY', 300, 300, {width: 100, align: 'center'})
               .text('AMOUNT', 430, 300, {width: 100, align: 'right'});

            // Table Content
            doc.fillColor('#000000').fontSize(14).text(`${order.service} Package`, 65, 340);
            doc.fontSize(10).font('Helvetica').fillColor('#666666')
               .text('Premium cinematic editing and post-production. Includes 1 free revision.', 65, 360, {width: 220});
            doc.fontSize(14).fillColor('#000000').text(formattedDeadline, 300, 340, {width: 100, align: 'center'});
            // FIX: Cast to Number before .toFixed() — Supabase returns numeric fields as strings
            doc.text(`INR ${Number(order.amount).toFixed(2)}`, 430, 340, {width: 100, align: 'right'});

            // Divider Line
            doc.moveTo(50, 400).lineTo(545, 400).lineWidth(1).strokeColor('#eeeeee').stroke();

            // Total Row
            doc.rect(50, 420, 495, 40).fill('#f8f8f8');
            doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text('TOTAL PAID:', 290, 433, {width: 100, align: 'right'});
            // FIX: Cast to Number before .toFixed() — Supabase returns numeric fields as strings
            doc.fillColor('#ff1a1a').fontSize(18).text(`INR ${Number(order.amount).toFixed(2)}`, 400, 431, {width: 130, align: 'right'});
            doc.moveTo(50, 460).lineTo(545, 460).lineWidth(2).strokeColor('#050505').stroke();

            // Payment Status
            doc.fontSize(12).fillColor('#888888').font('Helvetica-Bold').text('PAYMENT STATUS', 50, 520);
            doc.fontSize(18).fillColor('#22c55e').text('Paid in Full ✅', 50, 535);
            doc.fontSize(12).fillColor('#888888').font('Helvetica-Oblique').text('Thanks for giving us a chance to serve you.', 50, 560);

            // Footer
            doc.moveTo(50, 750).lineTo(545, 750).lineWidth(1).strokeColor('#cccccc').stroke();
            doc.fontSize(10).fillColor('#888888').font('Helvetica')
               .text('This is a computer-generated document. No signature is required.', 50, 765, {align: 'center'});
            doc.font('Helvetica-Bold').text('ZyroEditz | Cinematic Editing & Motion Graphics', 50, 780, {align: 'center'});

            doc.end();

        } catch (err) {
            reject(err);
        }
    });
}

module.exports = sendInvoice;
