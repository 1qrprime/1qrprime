const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: {
    type: String,
    sparse: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String, // Hashed password (bcrypt)
    select: false // Don't return password by default
  },
  name: {
    type: String,
    required: true
  },
  picture: {
    type: String
  },
  uniqueSlug: {
    type: String,
    unique: true,
    sparse: true
  },
  phoneNumber: {
    type: String,
    default: ''
  },
  showCallButton: {
    type: Boolean,
    default: true
  },
  showDownloadButton: {
    type: Boolean,
    default: true
  },
  showPaymentDetails: {
    type: Boolean,
    default: true
  },
  businessName: {
    type: String,
    default: ''
  },
  address: {
    type: String,
    default: ''
  },
  logo: {
    type: String, // Base64 data URL for logo
    default: ''
  },
  upiId: {
    type: String, // Client's UPI ID (optional - uses env var UPI_ID as fallback)
    default: ''
  },
  upiPayeeName: {
    type: String, // Payee name for UPI payments (optional - uses businessName or env var as fallback)
    default: ''
  },
  upiAid: {
    type: String, // App ID (aid) parameter for merchant payments - removes ₹2000 limit
    default: ''
  },
  bankQrCode: {
    type: String, // Bank's payment QR code image (base64 data URL) - uploaded by client
    default: ''
  },
  uploadedQrCode: {
    type: String, // Dynamic QR code image (base64 data URL) - uploaded by client or generated
    default: ''
  },
  paymentLink: {
    type: String, // UPI payment link (e.g., upi://collect?pa=...)
    default: ''
  },
  // QR code is no longer stored - generated on-demand to save storage costs
  // QR codes are deterministic (same input = same output), so we regenerate from uniqueSlug
  // This saves 100% of QR code storage costs for 10,000+ clients
  // qrCode field kept for backward compatibility but not used
  qrCode: {
    type: String, // Deprecated - QR codes generated on-demand now
    default: ''
  },
  paymentCompleted: {
    type: Boolean,
    default: false
  },
  accountActivated: {
    type: Boolean,
    default: false
  },
  paymentId: {
    type: String
  },
  subscriptionActive: {
    type: Boolean,
    default: false
  },
  subscriptionStartDate: {
    type: Date
  },
  subscriptionEndDate: {
    type: Date
  },
  subscriptionAmount: {
    type: Number,
    default: 999 // ₹999/year
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date
  }
});

// Index for faster queries
userSchema.index({ email: 1 });
userSchema.index({ uniqueSlug: 1 });
userSchema.index({ subscriptionActive: 1 });
userSchema.index({ createdAt: -1 });

module.exports = mongoose.model('User', userSchema);

