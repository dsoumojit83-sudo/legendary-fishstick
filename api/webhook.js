const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

// Connect to Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Configure the Gmail Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // Your 16-character App Password
    }
});

// The PDF Factory (Generates straight to RAM)
const createInvoiceBuffer = (orderId, amount) => {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));
        doc.on('error', reject);

        // --- DRAW THE INVOICE ---
        doc.fontSize(28).font('Helvetica-Bold').fillColor('#ff1a1a').text('ZyroEditz', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(12).fillColor('#888888').text('Official Payment Receipt', { align: 'center' });
        doc.moveDown(3);

        doc.fontSize(16).fillColor('#050505').font('Helvetica-Bold').text('Order Details');
        doc.moveDown(0.5);

        doc.fontSize(12).font('Helvetica');
        doc.text(`Order ID: ${orderId}`);
        doc.text(`Date: ${new Date().toLocaleDateString()}`);
        doc.text(`Status: PAID IN FULL`);

        doc.moveDown(2);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor('#e5e5e5').stroke();
        doc.moveDown(2);

        doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text(`Total Paid: ₹${amount}`);

        doc.moveDown(5);
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#888888').text(
            'Thank you for your business. Please upload your raw footage to the MEGA link provided in your email to begin the project.',
            { align: 'center' }
        );

        doc.end();
    });
};

module.exports = async function(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // --- 1. CASHFREE CRYPTOGRAPHIC SECURITY ---
        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];

        if (!signature || !timestamp) {
            console.error("🚨 Missing Cashfree security headers");
            return res.status(401).send("Unauthorized");
        }

        // CRITICAL FIX: Use the raw body buffer for signature verification
        // Vercel/Next.js and Express often parse the body, destroying the original format.
        // req.rawBody must be enabled in your server configuration (e.g., bodyParser.raw() or Next.js config)
        const rawBodyToHash = req.rawBody ? req.rawBody : JSON.stringify(req.body);
        const dataToHash = timestamp + rawBodyToHash;

        const expectedSignature = crypto
            .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
            .update(dataToHash)
            .digest('base64');

        if (expectedSignature !== signature) {
            // NOTE: If you are still getting signature errors, it means your server framework
            // is not exposing the unparsed raw string/buffer to `req.rawBody`.
            console.error("🚨 SECURITY ALERT: Invalid Webhook Signature! Expected:", expectedSignature, "Got:", signature);
            return res.status(403).send("Invalid signature");
        }

        // --- 2. PROCESS THE VERIFIED PAYMENT ---
        const payload = req.body;
        console.log("✅ Verified Webhook received");

        // Check if it's a successful payment
        // Cashfree webhook structure can vary depending on API version (PAYMENT_SUCCESS_WEBHOOK vs SUCCESS)
        if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK' || payload.event === 'PAYMENT_SUCCESS') {
            
            const orderId = payload.data?.order?.order_id || payload.data?.payment?.order_id;
            const orderAmount = payload.data?.order?.order_amount || payload.data?.payment?.payment_amount || 0;

            if (!orderId) {
                 return res.status(400).send("No order ID found in payload");
            }

            // Mark as paid in database
            const { data: order, error } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', orderId)
                .select()
                .single();

            if (error || !order) {
                console.error("Database Error (Order not found or update failed):", error);
                return res.status(500).send("Database update failed");
            }

            console.log(`✅ SUCCESS: Order ${orderId} secured and marked PAID in Supabase.`);

            // Generate the PDF in memory
            const pdfBuffer = await createInvoiceBuffer(orderId, orderAmount);

            // --- 3. SEND GMAIL WITH ATTACHMENT ---
            if (order.client_email) {
                await transporter.sendMail({
                    from: `"ZyroEditz" <${process.env.EMAIL_USER}>`,
                    to: order.client_email,
                    subject: `Project Started & Receipt: Order #${orderId}`,
                    html: `
                        <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
                            <h2>Payment Received! Let's get to work.</h2>
                            <p>Hey there, I've received your full payment for order <strong>#${orderId}</strong>. Your official receipt is attached to this email.</p>
                            <p><strong>Next Step:</strong> Please upload your raw footage, assets, and project brief to my MEGA folder below:</p>
                            <br/>
                            <a href="https://mega.nz/filerequest/I-2hfdO8CCo" style="display: inline-block; padding: 12px 24px; background-color: #ff1a1a; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Upload to MEGA</a>
                            <br/><br/>
                            <p>I'll notify you as soon as the first draft is ready for review.</p>
                            <hr />
                            <p>Best,<br /><strong>Soumojit Das</strong><br />Founder, ZyroEditz</p>
                        </div>
                    `,
                    attachments: [
                        {
                            filename: `ZyroEditz_Receipt_${orderId}.pdf`,
                            content: pdfBuffer,
                            contentType: 'application/pdf'
                        }
                    ]
                });
                console.log(`📧 SUCCESS: MEGA link and PDF receipt sent to ${order.client_email}.`);
            }

            return res.status(200).send("OK: Payment Processed");
        }

        return res.status(200).send("OK: Event received but ignored (Not a success event)");

    } catch (error) {
        console.error("Webhook Server Error:", error);
        return res.status(500).send("Server Error");
    }
};
