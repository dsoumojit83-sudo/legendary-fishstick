const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

// Connect to the Supabase "Brain"
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

        // Catch the data as PDFKit draws it
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
    // Only accept POST requests from Cashfree
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

        // Cashfree requires hashing the timestamp + the raw body
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const dataToHash = timestamp + rawBody;

        const expectedSignature = crypto
            .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
            .update(dataToHash)
            .digest('base64');

        if (expectedSignature !== signature) {
            console.error("🚨 SECURITY ALERT: Invalid Webhook Signature! Someone tried to fake a payment.");
            return res.status(403).send("Invalid signature");
        }

        // --- 2. PROCESS THE VERIFIED PAYMENT ---
        const payload = req.body;
        console.log("Verified Webhook received from Cashfree:", JSON.stringify(payload));

        const eventType = payload.type;
        const orderId = payload.data?.order?.order_id;
        const orderAmount = payload.data?.order?.order_amount || 0;

        // Check if this is a successful payment signal
        if (eventType && (eventType.includes('SUCCESS') || eventType === 'PAYMENT_SUCCESS_WEBHOOK') && orderId) {

            // Mark as paid in database
            const { data: order, error } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('order_id', orderId)
                .select()
                .single();

            if (error || !order) {
                console.error("Database Error:", error);
                return res.status(500).send("Database update failed");
            }

            console.log(`✅ SUCCESS: Order ${orderId} secured and marked PAID.`);

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

            // --- 4. SERVER-SIDE GOOGLE ANALYTICS ---
            if (process.env.NEXT_PUBLIC_GA_ID && process.env.GA_API_SECRET) {
                try {
                    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.NEXT_PUBLIC_GA_ID}&api_secret=${process.env.GA_API_SECRET}`, {
                        method: 'POST',
                        body: JSON.stringify({
                            client_id: orderId, // Using order ID as a unique identifier for the transaction session
                            events: [{
                                name: 'purchase',
                                params: {
                                    transaction_id: orderId,
                                    value: orderAmount,
                                    currency: 'INR'
                                }
                            }]
                        })
                    });
                    console.log(`📊 SUCCESS: Purchase logged to Google Analytics.`);
                } catch (gaError) {
                    console.error("GA Tracking failed (non-fatal):", gaError);
                }
            }

            return res.status(200).send("OK");
        }

        return res.status(200).send("Event received but ignored");

    } catch (error) {
        console.error("Webhook Server Error:", error);
        return res.status(500).send("Server Error");
    }
};
