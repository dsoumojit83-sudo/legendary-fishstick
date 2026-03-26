const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

// Create transporter once (not inside function)
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

async function sendInvoice(order) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: "A4",
                margin: 50
            });

            let buffers = [];

            doc.on("data", buffers.push.bind(buffers));

            doc.on("end", async () => {
                try {
                    const pdfData = Buffer.concat(buffers);

                    await transporter.sendMail({
                        from: `"ZyroEditz" <${process.env.EMAIL_USER}>`,
                        to: order.client_email,
                        subject: "Your Invoice - ZyroEditz",
                        html: `
                            <h2>Payment Confirmed ✅</h2>
                            <p>Hi ${order.client_name},</p>
                            <p>Your payment has been successfully received.</p>
                            <p><b>Order ID:</b> ${order.order_id}</p>
                            <p><b>Amount:</b> ₹${order.amount}</p>
                            <br/>
                            <p>Invoice attached below.</p>
                            <br/>
                            <p>– ZyroEditz</p>
                        `,
                        attachments: [
                            {
                                filename: "invoice.pdf",
                                content: pdfData
                            }
                        ]
                    });

                    console.log("✅ Invoice email sent");
                    resolve();
                } catch (err) {
                    console.error("❌ Email send error:", err);
                    reject(err);
                }
            });

            // 🎨 SIMPLE INVOICE DESIGN (you can upgrade later)
            doc.fontSize(20).text("ZyroEditz Invoice", { align: "center" });
            doc.moveDown();

            doc.fontSize(12).text(`Order ID: ${order.order_id}`);
            doc.text(`Client: ${order.client_name}`);
            doc.text(`Email: ${order.client_email}`);
            doc.text(`Amount Paid: ₹${order.amount}`);
            doc.moveDown();

            doc.text("Thank you for choosing ZyroEditz!", { align: "center" });

            doc.end();

        } catch (err) {
            reject(err);
        }
    });
}

module.exports = sendInvoice;
