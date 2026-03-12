const express = require('express');
const router = express.Router();
const connectDB = require('../config/database');
const User = require('../models/User');
const Link = require('../models/Link');
const Feedback = require('../models/Feedback');
const Settings = require('../models/Settings');
const path = require('path');
const fs = require('fs');
const Razorpay = require('razorpay');

// Ensure DB connection for serverless
router.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('Public route DB error:', error.message);
    // Don't crash - continue anyway, routes will handle DB errors individually
    next();
  }
});

// Public page for user's QR code
router.get('/:slug', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    // Check subscription status (consistent with rest of app)
    const now = new Date();
    const isActive = user.subscriptionActive && user.subscriptionEndDate && new Date(user.subscriptionEndDate) > now;
    
    // TEMPORARILY DISABLED for testing - uncomment after testing
    // if (!isActive) {
    //   return res.status(403).send('This page is not active. Subscription expired.');
    // }

    const links = await Link.find({ 
      userId: user._id, 
      isActive: true 
    }).sort({ order: 1 });

    // Generate QR code on-demand (no storage needed - saves 100% QR storage costs)
    // QR codes are deterministic, so we can regenerate anytime from user's slug
    let qrCode = null;
    try {
      const QRCode = require('qrcode');
      const baseUrl = process.env.BASE_URL || 'https://dynamicqrgen.vercel.app';
      const pageUrl = `${baseUrl}/p/${user.uniqueSlug}`;
      
      // Generate QR code
      const qrDataUrl = await QRCode.toDataURL(pageUrl, {
        width: 500,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      // Try to add business name if canvas is available
      let canvasAvailable = false;
      let createCanvas, loadImage;
      try {
        const canvasModule = require('canvas');
        createCanvas = canvasModule.createCanvas;
        loadImage = canvasModule.loadImage;
        canvasAvailable = true;
      } catch (error) {
        canvasAvailable = false;
      }

      if (canvasAvailable && user.businessName && user.businessName.trim() !== '') {
        try {
          const businessName = user.businessName || user.name || 'QR Code';
          const qrImage = await loadImage(qrDataUrl);
          
          const qrSize = 500;
          const padding = 40;
          const textHeight = 120; // Increased to accommodate 3 lines
          const canvasWidth = qrSize + (padding * 2);
          const canvasHeight = qrSize + (padding * 2) + textHeight;
          
          const canvas = createCanvas(canvasWidth, canvasHeight);
          const ctx = canvas.getContext('2d');
          
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
          ctx.drawImage(qrImage, padding, padding, qrSize, qrSize);
          
          // Draw business name with proper wrapping
          ctx.fillStyle = '#000000';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          
          const textX = canvasWidth / 2;
          const textY = qrSize + padding + 10;
          const maxWidth = qrSize - 40; // More margin for text
          const fontSize = 24; // Reduced font size
          const lineHeight = 32; // Line height for wrapped text
          
          // Set font
          ctx.font = `bold ${fontSize}px Arial`;
          
          // Improved word wrapping that handles long words
          const words = businessName.split(' ');
          const lines = [];
          let currentLine = '';
          
          for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const testLine = currentLine ? currentLine + ' ' + word : word;
            const metrics = ctx.measureText(testLine);
            
            if (metrics.width > maxWidth && currentLine) {
              // Current line is full, start new line
              lines.push(currentLine);
              currentLine = word;
              
              // If single word is too long, break it
              const wordMetrics = ctx.measureText(word);
              if (wordMetrics.width > maxWidth) {
                // Break long word into characters
                let charLine = '';
                for (let j = 0; j < word.length; j++) {
                  const testCharLine = charLine + word[j];
                  const charMetrics = ctx.measureText(testCharLine);
                  if (charMetrics.width > maxWidth && charLine) {
                    lines.push(charLine);
                    charLine = word[j];
                  } else {
                    charLine = testCharLine;
                  }
                }
                if (charLine) {
                  currentLine = charLine;
                } else {
                  currentLine = '';
                }
              }
            } else {
              currentLine = testLine;
            }
          }
          
          // Add the last line
          if (currentLine) {
            lines.push(currentLine);
          }
          
          // Draw all lines (max 3 lines)
          const linesToDraw = lines.slice(0, 3);
          linesToDraw.forEach((line, index) => {
            ctx.fillText(line.trim(), textX, textY + (index * lineHeight));
          });
          
          qrCode = canvas.toDataURL('image/png');
        } catch (canvasError) {
          qrCode = qrDataUrl;
        }
      } else {
        qrCode = qrDataUrl;
      }
    } catch (qrError) {
      console.error('Error generating QR code for public page:', qrError);
      // Continue without QR code if generation fails
    }

    res.render('public-page', {
      user: {
        ...user.toObject(),
        qrCode: qrCode
      },
      links,
      isPublic: true
    });
  } catch (error) {
    console.error('Public page error:', error);
    res.status(500).send('Error loading page');
  }
});

// Payment page - displays bank's QR code and UPI ID
// This is for client's customers to pay the client directly
router.get('/:slug/pay', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    // Check if payment is configured
    const hasBankQrCode = user.bankQrCode && user.bankQrCode.trim() !== '';
    const hasUpiId = user.upiId && user.upiId.trim() !== '';
    const hasPaymentLink = user.paymentLink && user.paymentLink.trim() !== '';
    
    // Escape payment link for HTML data attribute (escape quotes and ampersands)
    const escapedPaymentLink = (user.paymentLink || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    
    if (!hasBankQrCode && !hasUpiId && !hasPaymentLink) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Not Configured</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 20px;
              background: white;
              border-radius: 12px;
              max-width: 400px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>Payment Not Configured</h2>
            <p>Please configure payment in the dashboard.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Extract clean UPI ID if it's a full URL
    let upiId = user.upiId || '';
    if (upiId.includes('pa=')) {
      const match = upiId.match(/pa=([^&]+)/i);
      if (match) {
        upiId = decodeURIComponent(match[1]);
      }
    }
    
    const businessName = user.businessName || user.name || 'Merchant';
    
    // Render payment page with bank QR code and UPI ID
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pay ${businessName}</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
          }
          .container {
            background: white;
            border-radius: 16px;
            padding: 30px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
          }
          h1 {
            font-size: 24px;
            color: #333;
            margin-bottom: 10px;
            text-align: center;
          }
          .business-name {
            text-align: center;
            color: #666;
            margin-bottom: 30px;
            font-size: 16px;
          }
          .qr-section {
            text-align: center;
            margin-bottom: 30px;
          }
          .qr-code {
            max-width: 300px;
            width: 100%;
            height: auto;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            padding: 10px;
            background: white;
            margin: 0 auto 15px;
          }
          .qr-label {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
          }
          .download-btn {
            display: inline-block;
            padding: 10px 20px;
            background: #4285F4;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            margin-top: 10px;
            transition: background 0.3s;
          }
          .download-btn:hover {
            background: #3367d6;
          }
          .upi-section {
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #e0e0e0;
          }
          .upi-label {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
            text-align: center;
          }
          .upi-id-container {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            background: #f9f9f9;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 10px;
          }
          .upi-id {
            font-size: 18px;
            font-weight: 600;
            color: #333;
            font-family: monospace;
            flex: 1;
            text-align: center;
            word-break: break-all;
          }
          .copy-btn {
            padding: 8px 16px;
            background: #25D366;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.3s;
            white-space: nowrap;
          }
          .copy-btn:hover {
            background: #1da851;
          }
          .copy-btn:active {
            background: #1a8f45;
          }
          .instructions {
            text-align: center;
            color: #888;
            font-size: 12px;
            margin-top: 20px;
            line-height: 1.6;
          }
          .back-link {
            display: block;
            text-align: center;
            margin-top: 20px;
            color: #4285F4;
            text-decoration: none;
            font-size: 14px;
          }
          .back-link:hover {
            text-decoration: underline;
          }
          .no-qr-message {
            text-align: center;
            color: #666;
            padding: 20px;
            background: #f9f9f9;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .payment-link-section {
            margin-top: 30px;
            padding-top: 30px;
            border-top: 1px solid #e0e0e0;
            text-align: center;
          }
          .payment-link-btn {
            padding: 15px 30px;
            background: #4285F4;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.3s;
            width: 100%;
            max-width: 300px;
          }
          .payment-link-btn:hover {
            background: #3367d6;
          }
          .payment-link-btn:active {
            background: #2a5bc4;
          }
          .payment-link-label {
            font-size: 14px;
            color: #666;
            margin-bottom: 15px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Pay ${businessName}</h1>
          <p class="business-name">Scan QR code or copy UPI ID to pay</p>
          
          ${hasBankQrCode ? `
            <div class="qr-section">
              <p class="qr-label">Scan this QR code to pay</p>
              <img src="${user.bankQrCode}" alt="Payment QR Code" class="qr-code" id="qrCodeImage">
              <a href="${user.bankQrCode}" download="payment-qr-code.png" class="download-btn">Download QR Code</a>
            </div>
          ` : `
            <div class="no-qr-message">
              <p>QR code not available. Please use UPI ID below to pay.</p>
            </div>
          `}
          
          ${hasUpiId ? `
            <div class="upi-section">
              <p class="upi-label">Or copy UPI ID to pay manually</p>
              <div class="upi-id-container">
                <span class="upi-id" id="upiId">${upiId}</span>
                <button class="copy-btn" onclick="copyUpiId()">Copy</button>
              </div>
            </div>
          ` : ''}
          
          ${hasPaymentLink ? `
            <div class="payment-link-section">
              <p class="payment-link-label">Or click to open payment link</p>
              <button class="payment-link-btn" id="paymentLinkBtn" data-payment-link="${escapedPaymentLink}">Click to Pay</button>
              <p style="font-size: 12px; color: #888; margin-top: 10px;">
                <a href="#" id="manualPaymentLink" style="color: #4285F4; text-decoration: none;">Click here if payment app doesn't open</a>
              </p>
            </div>
          ` : ''}
          
          <div class="instructions">
            <p><strong>How to pay:</strong></p>
            <p>1. Open any UPI app (Google Pay, PhonePe, Paytm, etc.)</p>
            ${hasBankQrCode ? '<p>2. Scan the QR code above</p>' : ''}
            ${hasUpiId ? '<p>2. Or copy the UPI ID manually</p>' : ''}
            ${hasPaymentLink ? '<p>2. Or click the payment link button above</p>' : ''}
            <p>3. Enter amount and complete payment</p>
          </div>
          
          <a href="/p/${user.uniqueSlug}" class="back-link">← Back to ${businessName}</a>
        </div>
        
        <script>
          function copyUpiId() {
            const upiId = document.getElementById('upiId').textContent;
            const btn = event.target;
            const originalText = btn.textContent;
            
            // Try modern clipboard API first
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(upiId).then(function() {
                btn.textContent = 'Copied!';
                btn.style.background = '#4CAF50';
                setTimeout(function() {
                  btn.textContent = originalText;
                  btn.style.background = '#25D366';
                }, 2000);
              }).catch(function(err) {
                // Fallback to old method
                fallbackCopy(upiId, btn, originalText);
              });
            } else {
              // Fallback for browsers without clipboard API
              fallbackCopy(upiId, btn, originalText);
            }
          }
          
          function fallbackCopy(text, btn, originalText) {
            // Create temporary textarea
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.left = '-999999px';
            textarea.style.top = '-999999px';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            
            try {
              const successful = document.execCommand('copy');
              if (successful) {
                btn.textContent = 'Copied!';
                btn.style.background = '#4CAF50';
                setTimeout(function() {
                  btn.textContent = originalText;
                  btn.style.background = '#25D366';
                }, 2000);
              } else {
                // If execCommand fails, show manual copy option
                showManualCopy(text, btn, originalText);
              }
            } catch (err) {
              // If execCommand fails, show manual copy option
              showManualCopy(text, btn, originalText);
            } finally {
              document.body.removeChild(textarea);
            }
          }
          
          function showManualCopy(text, btn, originalText) {
            // Select the text in the UPI ID element
            const upiIdElement = document.getElementById('upiId');
            const range = document.createRange();
            range.selectNodeContents(upiIdElement);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            
            // Show message
            btn.textContent = 'Select & Copy';
            btn.style.background = '#ff9800';
            setTimeout(function() {
              btn.textContent = originalText;
              btn.style.background = '#25D366';
            }, 3000);
          }
          
          // Payment link button handler
          (function() {
            const paymentLinkBtn = document.getElementById('paymentLinkBtn');
            const manualPaymentLink = document.getElementById('manualPaymentLink');
            
            if (!paymentLinkBtn) {
              console.log('Payment link button not found');
              return;
            }
            
            const paymentLink = paymentLinkBtn.getAttribute('data-payment-link');
            console.log('Payment link from data attribute:', paymentLink);
            
            if (!paymentLink || paymentLink.trim() === '') {
              console.log('Payment link is empty');
              paymentLinkBtn.disabled = true;
              paymentLinkBtn.textContent = 'Payment Link Not Configured';
              if (manualPaymentLink) manualPaymentLink.style.display = 'none';
              return;
            }
            
            // Decode HTML entities once
            const decodedLink = paymentLink
              .replace(/&amp;/g, '&')
              .replace(/&quot;/g, '"')
              .replace(/&#x27;/g, "'")
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>');
            
            console.log('Decoded payment link:', decodedLink);
            
            // Function to open payment link
            function openPaymentLink() {
              console.log('Attempting to open:', decodedLink);
              
              // Try multiple methods
              try {
                // Method 1: Direct location change
                window.location.href = decodedLink;
              } catch (e) {
                console.error('Method 1 failed:', e);
                try {
                  // Method 2: Create and click link
                  const link = document.createElement('a');
                  link.href = decodedLink;
                  link.target = '_blank';
                  document.body.appendChild(link);
                  link.click();
                  setTimeout(function() {
                    document.body.removeChild(link);
                  }, 100);
                } catch (e2) {
                  console.error('Method 2 failed:', e2);
                  // Method 3: window.open
                  window.open(decodedLink, '_blank');
                }
              }
            }
            
            // Button click handler
            paymentLinkBtn.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopPropagation();
              
              // Show feedback
              this.textContent = 'Opening...';
              
              // Open immediately
              openPaymentLink();
            });
            
            // Manual link click handler
            if (manualPaymentLink) {
              manualPaymentLink.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                openPaymentLink();
              });
              // Set the href as well for right-click "Open in new tab"
              manualPaymentLink.href = decodedLink;
            }
          })();
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Payment page error:', error);
    res.status(500).send('Error loading payment page');
  }
});

// Helper function to enhance UPI links - MINIMAL changes, keep it simple
// Only adds missing essential parameters, preserves original format
function enhanceUPILink(upiUrl, user) {
  try {
    // Clean the URL - remove any extra whitespace
    let enhancedUrl = upiUrl.trim();
    
    // Parse parameters manually (upi:// scheme doesn't work well with URL constructor)
    const parts = enhancedUrl.split('?');
    const scheme = parts[0]; // upi://pay
    const queryString = parts[1] || '';
    
    // Parse existing parameters - keep original encoding
    const params = {};
    const paramOrder = []; // Preserve original order
    
    if (queryString) {
      queryString.split('&').forEach(param => {
        const [key, value] = param.split('=');
        if (key && value) {
          // Keep original encoded value - don't decode/re-encode
          params[key] = value; // Keep as-is (already encoded)
          paramOrder.push(key);
        }
      });
    }
    
    // Only add cu if missing (minimal change)
    if (!params.cu) {
      params.cu = 'INR';
      paramOrder.push('cu');
    }
    
    // IMPORTANT: Remove 'am' (amount) parameter - no amount limits
    if (params.am) {
      delete params.am;
      const index = paramOrder.indexOf('am');
      if (index > -1) paramOrder.splice(index, 1);
    }
    
    // Reconstruct URL preserving original order + any new params
    const paramPairs = [];
    
    // Add params in original order
    paramOrder.forEach(key => {
      if (params[key]) {
        paramPairs.push(`${key}=${params[key]}`); // Already encoded
      }
    });
    
    // Reconstruct the full URL
    const newQueryString = paramPairs.join('&');
    return `${scheme}?${newQueryString}`;
    
  } catch (error) {
    // Fallback: return original URL if enhancement fails
    console.error('UPI link enhancement error:', error);
    return upiUrl.trim();
  }
}

// Redirect handler for links
router.get('/:slug/redirect/:linkId', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    // Check subscription status (consistent with rest of app)
    const now = new Date();
    const isActive = user.subscriptionActive && user.subscriptionEndDate && new Date(user.subscriptionEndDate) > now;
    
    // TEMPORARILY DISABLED for testing - uncomment after testing
    // if (!isActive) {
    //   return res.status(403).send('This page is not active. Subscription expired.');
    // }

    const link = await Link.findById(req.params.linkId);
    
    if (!link || link.userId.toString() !== user._id.toString() || !link.isActive) {
      return res.status(404).send('Link not found');
    }

    // Check if this is a UPI payment link - supports both upi://pay and upi://collect
    const isUPILink = link.url && (
      link.url.toLowerCase().startsWith('upi://') ||
      link.url.toLowerCase().startsWith('upiqr://')
    );

    // For UPI links, enhance with required parameters and open UPI app directly
    if (isUPILink) {
      // Enhance UPI link with required parameters (pn, cu, tn, tr) for Google Pay/PhonePe compatibility
      const enhancedUPIUrl = enhanceUPILink(link.url.trim(), user);
      // For upi:// links, use as-is (already properly encoded in enhanceUPILink)
      const encodedForHref = enhancedUPIUrl;
      
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Opening Payment...</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 20px;
            }
            .open-link {
              display: inline-block;
              margin-top: 15px;
              padding: 12px 24px;
              background: #4285F4;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-size: 16px;
            }
            .open-link:hover {
              background: #3367d6;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <p>Opening payment app...</p>
            <a href="${encodedForHref}" class="open-link">Click here if app doesn't open</a>
          </div>
          <script>
            (function() {
              const upiUrl = ${JSON.stringify(enhancedUPIUrl)};
              console.log('Opening enhanced UPI link:', upiUrl);
              
              // Try to open immediately
              try {
                window.location.href = upiUrl;
              } catch (e) {
                console.error('Error:', e);
                // Fallback: create and click link
                const link = document.createElement('a');
                link.href = upiUrl;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                setTimeout(function() {
                  document.body.removeChild(link);
                }, 100);
              }
            })();
          </script>
        </body>
        </html>
      `);
    }

    // Check for menu/bar/products/services/custom categories that have menu items or images
    const menuCategories = ['menu', 'bar', 'products', 'services'];
    const isMenuCategory = menuCategories.includes(link.category) || link.categoryType === 'custom';
    
    if (isMenuCategory) {
      const menuType = link.menuType || 'url';
      
      // If menuType is 'items' and menuItems exist, show menu page
      if (menuType === 'items' && link.menuItems && link.menuItems.length > 0) {
        const pageTitle = link.displayName || (link.category === 'bar' ? 'Bar' : (link.category === 'products' ? 'Products' : (link.category === 'services' ? 'Services' : (link.categoryType === 'custom' ? 'Custom' : 'Menu'))));
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${user.businessName || user.name} - ${pageTitle}</title>
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                background: #000000;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: flex-start;
                padding: 20px;
              }
              .menu-container {
                max-width: 900px;
                width: 100%;
                text-align: center;
              }
              .menu-title {
                color: #fff;
                font-size: 28px;
                font-weight: 600;
                margin-bottom: 30px;
              }
              .menu-category {
                margin-bottom: 40px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 12px;
                padding: 20px;
                border: 1px solid rgba(255, 255, 255, 0.1);
              }
              .category-name {
                color: #fff;
                font-size: 22px;
                font-weight: 600;
                margin-bottom: 20px;
                text-align: left;
                padding-bottom: 10px;
                border-bottom: 2px solid rgba(255, 107, 107, 0.5);
              }
              .menu-table {
                width: 100%;
                border-collapse: collapse;
                background: rgba(255, 255, 255, 0.03);
                border-radius: 8px;
                overflow: hidden;
              }
              .menu-table thead {
                background: rgba(255, 107, 107, 0.2);
              }
              .menu-table th {
                color: #fff;
                padding: 15px;
                text-align: left;
                font-weight: 600;
                font-size: 14px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                border-bottom: 2px solid rgba(255, 107, 107, 0.3);
              }
              .menu-table th:first-child {
                width: 60%;
              }
              .menu-table th:last-child {
                width: 40%;
                text-align: right;
              }
              .menu-table td {
                color: #fff;
                padding: 15px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                font-size: 15px;
              }
              .menu-table tbody tr:hover {
                background: rgba(255, 107, 107, 0.1);
              }
              .menu-table tbody tr:last-child td {
                border-bottom: none;
              }
              .item-name {
                color: #fff;
                font-weight: 500;
              }
              .item-price {
                color: #fff;
                text-align: right;
                font-weight: 600;
                color: #FF6B6B;
              }
              .back-button {
                display: inline-block;
                margin-top: 30px;
                padding: 12px 24px;
                background: linear-gradient(135deg, #4285F4, #25D366);
                color: white;
                text-decoration: none;
                border-radius: 12px;
                font-weight: 600;
                font-size: 14px;
                transition: all 0.3s ease;
              }
              .back-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(66, 133, 244, 0.4);
              }
              @media (max-width: 768px) {
                .menu-container {
                  padding: 10px;
                }
                .menu-table {
                  font-size: 13px;
                }
                .menu-table th,
                .menu-table td {
                  padding: 10px 8px;
                }
                .category-name {
                  font-size: 18px;
                }
              }
            </style>
          </head>
          <body>
            <div class="menu-container">
              <h1 class="menu-title">${pageTitle}</h1>
              ${link.menuItems.map(category => `
                <div class="menu-category">
                  <h2 class="category-name">${category.categoryName}</h2>
                  <table class="menu-table">
                    <thead>
                      <tr>
                        <th>Item Name</th>
                        <th>Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${category.items.map(item => `
                        <tr>
                          <td class="item-name">${item.name}</td>
                          <td class="item-price">₹${item.price.toFixed(2)}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                </div>
              `).join('')}
              <a href="/p/${user.uniqueSlug}" class="back-button">
                <i class="fas fa-arrow-left"></i> Back to ${user.businessName || user.name}
              </a>
            </div>
          </body>
          </html>
        `);
      }
      
      // If menuType is 'images' and menuCardImages exist, show images page
      if (menuType === 'images' && link.menuCardImages && link.menuCardImages.length > 0) {
        const pageTitle = link.displayName || (link.category === 'bar' ? 'Bar' : (link.category === 'products' ? 'Products' : (link.category === 'services' ? 'Services' : (link.categoryType === 'custom' ? 'Custom' : 'Menu'))));
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${user.businessName || user.name} - ${pageTitle}</title>
            <style>
              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                background: #000000;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: flex-start;
                padding: 20px;
              }
              .menu-container {
                max-width: 800px;
                width: 100%;
                text-align: center;
              }
              .menu-title {
                color: #fff;
                font-size: 24px;
                font-weight: 600;
                margin-bottom: 20px;
              }
              .menu-images-container {
                display: flex;
                flex-direction: column;
                gap: 20px;
              }
              .menu-image {
                max-width: 100%;
                height: auto;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                background: white;
                padding: 10px;
              }
              .back-button {
                display: inline-block;
                margin-top: 20px;
                padding: 12px 24px;
                background: linear-gradient(135deg, #4285F4, #25D366);
                color: white;
                text-decoration: none;
                border-radius: 12px;
                font-weight: 600;
                font-size: 14px;
                transition: all 0.3s ease;
              }
              .back-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(66, 133, 244, 0.4);
              }
            </style>
          </head>
          <body>
            <div class="menu-container">
              <h1 class="menu-title">${pageTitle}</h1>
              <div class="menu-images-container">
                ${link.menuCardImages.map((image, index) => 
                  `<img src="${image}" alt="${pageTitle} ${index + 1}" class="menu-image">`
                ).join('')}
              </div>
              <a href="/p/${user.uniqueSlug}" class="back-button">
                <i class="fas fa-arrow-left"></i> Back to ${user.businessName || user.name}
              </a>
            </div>
          </body>
          </html>
        `);
      }
      
      // For custom links with 'url' type - redirect to URL only if URL exists and is not empty
      // If URL is empty but menu items/images exist, they will be shown by the checks above
      if (link.categoryType === 'custom' && menuType === 'url' && !isUPILink) {
        if (link.url && link.url.trim() !== '') {
          return res.redirect(link.url);
        } else {
          // If URL is empty, check if we have menu items or images to show
          // If menu items exist, they should have been handled by the items check above
          // If menu images exist, they should have been handled by the images check above
          // If neither exists, show an error
          return res.status(400).send('No URL or menu content available. Please add a URL or create menu items/images.');
        }
      }
      
      // For menu/bar/products/services with 'url' type but no URL - check if items/images exist
      if (menuCategories.includes(link.category) && menuType === 'url') {
        if (link.url && link.url.trim() !== '') {
          return res.redirect(link.url);
        } else {
          // If URL is empty but menu items/images exist, they should have been shown above
          // If not, show an error
          return res.status(400).send('No URL provided. Please add a URL or create menu items/images.');
        }
      }
    }

    // For regular links, redirect normally only if URL exists and is not empty
    if (link.url && link.url.trim() !== '') {
      return res.redirect(link.url);
    } else {
      return res.status(400).send('No URL provided for this link');
    }
  } catch (error) {
    console.error('Redirect error:', error);
    res.status(500).send('Error redirecting');
  }
});

// Generate QR code for download (on-demand, exact same as client generated)
router.get('/:slug/qr-code', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    const QRCode = require('qrcode');
    const baseUrl = process.env.BASE_URL || 'https://dynamicqrgen.vercel.app';
    const pageUrl = `${baseUrl}/p/${user.uniqueSlug}`;
    
    // Generate QR code (exact same as client generated)
    const qrDataUrl = await QRCode.toDataURL(pageUrl, {
      width: 500,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Try to add business name if canvas is available (exact same as client version)
    let canvasAvailable = false;
    let createCanvas, loadImage, registerFont;
    try {
      const canvasModule = require('canvas');
      createCanvas = canvasModule.createCanvas;
      loadImage = canvasModule.loadImage;
      registerFont = canvasModule.registerFont;
      canvasAvailable = true;
      
      // Register font file for Vercel compatibility (required for text rendering)
      try {
        const fontPath = path.join(__dirname, '../fonts', 'Roboto-Regular.ttf');
        if (fs.existsSync(fontPath)) {
          registerFont(fontPath, { family: 'Roboto' });
          console.log('✅ Registered Roboto font from file');
        } else {
          console.warn('⚠️  Roboto font file not found at:', fontPath);
          console.warn('⚠️  Text rendering may show boxes on Vercel without font file');
        }
      } catch (fontError) {
        console.error('❌ Error registering font:', fontError.message);
        console.warn('⚠️  Text rendering may show boxes on Vercel');
      }
    } catch (error) {
      console.warn('Canvas not available:', error.message);
      canvasAvailable = false;
    }
    
    // Helper function to render text - use registered Roboto font or fallback
    function renderTextWithFallback(ctx, text, x, y, maxWidth) {
      const fontConfigs = [
        'bold 32px Roboto',  // Registered font (if available)
        'bold 32px',  // Canvas default (may show boxes on Vercel)
        '32px Roboto',  // Without bold
        '32px'  // Ultimate fallback
      ];
      
      for (const fontConfig of fontConfigs) {
        try {
          ctx.font = fontConfig;
          const metrics = ctx.measureText(text);
          if (metrics.width > 0 && metrics.width < maxWidth * 3) {
            return { font: fontConfig, metrics };
          }
        } catch (e) {
          continue;
        }
      }
      
      ctx.font = '32px';
      return { font: '32px', metrics: ctx.measureText(text) };
    }

    let finalQrDataUrl = qrDataUrl;
    
    // Add business name below QR code (exact same logic as client dashboard)
    console.log('Public QR Generation Debug:', {
      canvasAvailable,
      hasBusinessName: !!user.businessName,
      businessName: user.businessName,
      businessNameTrimmed: user.businessName ? user.businessName.trim() : ''
    });
    
    if (canvasAvailable && user.businessName && user.businessName.trim() !== '') {
      try {
        const businessName = user.businessName.trim();
        console.log('✅ Adding business name to QR:', businessName);
        
        const qrImage = await loadImage(qrDataUrl);
        
        const qrSize = 500;
        const padding = 40;
        const textHeight = 120; // Increased to accommodate 3 lines
        const canvasWidth = qrSize + (padding * 2);
        const canvasHeight = qrSize + (padding * 2) + textHeight;
        
        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');
        
        // White background
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Draw QR code
        ctx.drawImage(qrImage, padding, padding, qrSize, qrSize);
        
        // Draw business name with proper wrapping
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        
        const textX = canvasWidth / 2;
        const textY = qrSize + padding + 10;
        const maxWidth = qrSize - 40; // More margin for text
        const fontSize = 24; // Reduced font size
        const lineHeight = 32; // Line height for wrapped text
        
        // Set font
        ctx.font = `bold ${fontSize}px Arial`;
        
        // Improved word wrapping that handles long words
        const words = businessName.split(' ');
        const lines = [];
        let currentLine = '';
        
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const testLine = currentLine ? currentLine + ' ' + word : word;
          const metrics = ctx.measureText(testLine);
          
          if (metrics.width > maxWidth && currentLine) {
            // Current line is full, start new line
            lines.push(currentLine);
            currentLine = word;
            
            // If single word is too long, break it
            const wordMetrics = ctx.measureText(word);
            if (wordMetrics.width > maxWidth) {
              // Break long word into characters
              let charLine = '';
              for (let j = 0; j < word.length; j++) {
                const testCharLine = charLine + word[j];
                const charMetrics = ctx.measureText(testCharLine);
                if (charMetrics.width > maxWidth && charLine) {
                  lines.push(charLine);
                  charLine = word[j];
                } else {
                  charLine = testCharLine;
                }
              }
              if (charLine) {
                currentLine = charLine;
              } else {
                currentLine = '';
              }
            }
          } else {
            currentLine = testLine;
          }
        }
        
        // Add the last line
        if (currentLine) {
          lines.push(currentLine);
        }
        
        // Draw all lines (max 3 lines)
        const linesToDraw = lines.slice(0, 3);
        linesToDraw.forEach((line, index) => {
          ctx.fillText(line.trim(), textX, textY + (index * lineHeight));
        });
        
        finalQrDataUrl = canvas.toDataURL('image/png');
        console.log('QR code with business name generated successfully');
      } catch (canvasError) {
        console.error('Canvas error while adding business name:', canvasError);
        // Fallback to QR code without text
        finalQrDataUrl = qrDataUrl;
      }
    } else {
      if (!canvasAvailable) {
        console.warn('Canvas not available - QR code generated without business name');
      } else if (!user.businessName || user.businessName.trim() === '') {
        console.warn('Business name not set - QR code generated without business name');
      }
    }

    // Convert base64 to buffer and send as PNG
    const base64Data = finalQrDataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="qr-code-${user.uniqueSlug}.png"`);
    res.send(buffer);
  } catch (error) {
    console.error('QR code generation error:', error);
    res.status(500).send('Error generating QR code');
  }
});

// Download generated dynamic QR code (the one generated from links, points to /p/:slug)
router.get('/:slug/download/dynamic-qr', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    const QRCode = require('qrcode');
    const baseUrl = process.env.BASE_URL || 'https://dynamicqrgen.vercel.app';
    const pageUrl = `${baseUrl}/p/${user.uniqueSlug}`;
    
    // Generate QR code (exact same as client generated)
    let qrDataUrl = await QRCode.toDataURL(pageUrl, {
      width: 500,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Try to add business name if canvas is available
    let canvasAvailable = false;
    let createCanvas, loadImage, registerFont;
    try {
      const canvasModule = require('canvas');
      createCanvas = canvasModule.createCanvas;
      loadImage = canvasModule.loadImage;
      registerFont = canvasModule.registerFont;
      canvasAvailable = true;
      
      // Register font file for Vercel compatibility
      try {
        const fontPath = path.join(__dirname, '../fonts', 'Roboto-Regular.ttf');
        if (fs.existsSync(fontPath)) {
          registerFont(fontPath, { family: 'Roboto' });
        }
      } catch (fontError) {
        console.warn('Font registration error:', fontError.message);
      }
    } catch (error) {
      canvasAvailable = false;
    }
    
    // Helper function to render text
    function renderTextWithFallback(ctx, text, x, y, maxWidth) {
      try {
        ctx.font = 'bold 32px Roboto';
        ctx.fillText(text, x, y);
      } catch (e) {
        try {
          ctx.font = 'bold 32px Arial';
          ctx.fillText(text, x, y);
        } catch (e2) {
          ctx.font = '32px sans-serif';
          ctx.fillText(text, x, y);
        }
      }
    }
    
    if (canvasAvailable && user.businessName && user.businessName.trim() !== '') {
      try {
        const businessName = user.businessName || user.name || 'QR Code';
        const qrImage = await loadImage(qrDataUrl);
        
        const qrSize = 500;
        const padding = 40;
        const textHeight = 120; // Increased to accommodate 3 lines
        const canvasWidth = qrSize + (padding * 2);
        const canvasHeight = qrSize + (padding * 2) + textHeight;
        
        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');
        
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.drawImage(qrImage, padding, padding, qrSize, qrSize);
        
        // Draw business name with proper wrapping
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        
        const textX = canvasWidth / 2;
        const textY = qrSize + padding + 10;
        const maxWidth = qrSize - 40; // More margin for text
        const fontSize = 24; // Reduced font size
        const lineHeight = 32; // Line height for wrapped text
        
        // Set font
        ctx.font = `bold ${fontSize}px Arial`;
        
        // Improved word wrapping that handles long words
        const words = businessName.split(' ');
        const lines = [];
        let currentLine = '';
        
        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const testLine = currentLine ? currentLine + ' ' + word : word;
          const metrics = ctx.measureText(testLine);
          
          if (metrics.width > maxWidth && currentLine) {
            // Current line is full, start new line
            lines.push(currentLine);
            currentLine = word;
            
            // If single word is too long, break it
            const wordMetrics = ctx.measureText(word);
            if (wordMetrics.width > maxWidth) {
              // Break long word into characters
              let charLine = '';
              for (let j = 0; j < word.length; j++) {
                const testCharLine = charLine + word[j];
                const charMetrics = ctx.measureText(testCharLine);
                if (charMetrics.width > maxWidth && charLine) {
                  lines.push(charLine);
                  charLine = word[j];
                } else {
                  charLine = testCharLine;
                }
              }
              if (charLine) {
                currentLine = charLine;
              } else {
                currentLine = '';
              }
            }
          } else {
            currentLine = testLine;
          }
        }
        
        // Add the last line
        if (currentLine) {
          lines.push(currentLine);
        }
        
        // Draw all lines (max 3 lines)
        const linesToDraw = lines.slice(0, 3);
        linesToDraw.forEach((line, index) => {
          ctx.fillText(line.trim(), textX, textY + (index * lineHeight));
        });
        
        qrDataUrl = canvas.toDataURL('image/png');
      } catch (canvasError) {
        console.warn('Canvas error, using QR without text:', canvasError.message);
      }
    }

    // Convert data URL to buffer for download
    const base64Data = qrDataUrl.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="dynamic-qr-${user.uniqueSlug}.png"`);
    res.send(buffer);
  } catch (error) {
    console.error('Dynamic QR download error:', error);
    res.status(500).send('Error downloading QR code');
  }
});

// Download payment QR code
router.get('/:slug/download/payment-qr', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).send('Page not found');
    }

    if (!user.bankQrCode || user.bankQrCode.trim() === '') {
      return res.status(404).send('Payment QR code not found');
    }

    // Extract base64 data from data URL
    const base64Data = user.bankQrCode.split(',')[1];
    if (!base64Data) {
      return res.status(500).send('Invalid QR code format');
    }

    const buffer = Buffer.from(base64Data, 'base64');
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="payment-qr-${user.uniqueSlug}.png"`);
    res.send(buffer);
  } catch (error) {
    console.error('Payment QR download error:', error);
    res.status(500).send('Error downloading QR code');
  }
});

// Submit feedback
router.post('/:slug/feedback', async (req, res) => {
  try {
    const user = await User.findOne({ uniqueSlug: req.params.slug });
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { rating } = req.body;
    
    // Validate rating
    const ratingNum = parseInt(rating);
    if (isNaN(ratingNum) || ratingNum < 0 || ratingNum > 5) {
      return res.status(400).json({ success: false, message: 'Invalid rating' });
    }

    // Determine feedback type based on rating
    // 0 stars (no click/enter) = "not_useful"
    // 1-3 stars = "good_idea"
    // 4-5 stars = "very_useful"
    let feedbackType;
    if (ratingNum === 0) {
      feedbackType = 'not_useful';
    } else if (ratingNum >= 1 && ratingNum <= 3) {
      feedbackType = 'good_idea';
    } else if (ratingNum >= 4 && ratingNum <= 5) {
      feedbackType = 'very_useful';
    } else {
      feedbackType = 'not_useful'; // Default fallback
    }

    // Check if this is an update (user changing their feedback)
    // We'll still create a new entry for analytics, but mark it as an update
    const isUpdate = req.body.isUpdate || false;

    // Create feedback entry (always create new for analytics tracking)
    const feedback = new Feedback({
      userId: user._id,
      rating: ratingNum,
      feedbackType: feedbackType
    });

    await feedback.save();

    res.json({ 
      success: true, 
      message: isUpdate ? 'Feedback updated successfully' : 'Feedback submitted successfully',
      feedbackType: feedbackType,
      isUpdate: isUpdate
    });
  } catch (error) {
    console.error('Feedback submission error:', error);
    res.status(500).json({ success: false, message: 'Error submitting feedback' });
  }
});

// Get public settings (for footer display on all pages)
router.get('/api/settings', async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    res.json({
      success: true,
      usersCount: settings.usersCount || 0,
      clientsCount: settings.clientsCount || 0
    });
  } catch (error) {
    console.error('Get public settings error:', error);
    // Return defaults if error
    res.json({
      success: true,
      usersCount: 0,
      clientsCount: 0
    });
  }
});

module.exports = router;

