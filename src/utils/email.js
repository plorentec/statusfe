const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const settings = require('../db/models').settings;
  const smtp = settings.get('smtp_host');
  const port = settings.get('smtp_port');
  const user = settings.get('smtp_user');
  const pass = settings.get('smtp_pass');
  const secure = settings.get('smtp_secure') === 'true';
  const from = settings.get('smtp_from');

  if (!smtp || !from) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: smtp,
    port: parseInt(port) || 587,
    secure: secure || false,
    auth: user ? { user, pass } : undefined,
  });

  return transporter;
}

async function sendEmail(to, subject, html) {
  const settings = require('../db/models').settings;
  const from = settings.get('smtp_from');
  const name = settings.get('smtp_from_name') || 'StatusFe';

  if (!from) {
    return { ok: false, error: 'No SMTP from address configured' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'SMTP not configured (missing host or from address)' };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${name}" <${from}>`,
      to,
      subject,
      html,
    });
    console.log('Email sent successfully:', info.messageId);
    return { ok: true };
  } catch (err) {
    console.error('Email send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

async function notifyComponentStatusChange(componentName, oldStatus, newStatus, pageTitle) {
  const { users } = require('../db/models');
  const admins = await users.listAdmins();
  const statusLabels = {
    operational: 'Operational',
    degraded_performance: 'Degraded Performance',
    partial_outage: 'Partial Outage',
    major_outage: 'Major Outage',
    under_maintenance: 'Under Maintenance',
  };

  const subject = `[StatusFe] ${pageTitle}: ${componentName} status changed`;
  const html = `
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Component Status Change</h2>
      <p><strong>Page:</strong> ${pageTitle}</p>
      <p><strong>Component:</strong> ${componentName}</p>
      <p><strong>Old Status:</strong> <span style="text-transform: capitalize; font-weight: 600;">${statusLabels[oldStatus] || oldStatus}</span></p>
      <p><strong>New Status:</strong> <span style="text-transform: capitalize; font-weight: 600;">${statusLabels[newStatus] || newStatus}</span></p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #64748b; font-size: 13px;">StatusFe Notification</p>
    </div>
  `;

  const results = [];
  for (const admin of admins) {
    const enabled = admin.email_notifications !== 0;
    const sent = await sendEmail(admin.email, subject, html);
    results.push({ email: admin.email, sent, enabled });
  }
  return results;
}

async function notifyIncident(created, incidentName, status, description, pageTitle) {
  const { users } = require('../db/models');
  const admins = await users.listAdmins();

  const subject = `[StatusFe] ${pageTitle}: ${created ? 'New incident' : 'Incident updated'} - ${incidentName}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #1e293b;">${created ? 'New Incident' : 'Incident Updated'}</h2>
      <p><strong>Page:</strong> ${pageTitle}</p>
      <p><strong>Incident:</strong> ${incidentName}</p>
      <p><strong>Status:</strong> <span style="text-transform: capitalize; font-weight: 600;">${status}</span></p>
      ${description ? `<p><strong>Description:</strong> ${description}</p>` : ''}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #64748b; font-size: 13px;">StatusFe Notification</p>
    </div>
  `;

  const results = [];
  for (const admin of admins) {
    const sent = await sendEmail(admin.email, subject, html);
    results.push({ email: admin.email, sent });
  }
  return results;
}

async function sendWelcomeEmail(email, name, resetUrl) {
  const settings = require('../db/models').settings;
  const from = settings.get('smtp_from');
  const nameFrom = settings.get('smtp_from_name') || 'StatusFe';

  if (!from) {
    return { ok: false, error: 'No SMTP from address configured' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: 'SMTP not configured' };
  }

  const html = `
    <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Welcome to StatusFe!</h2>
      <p>Hello <strong>${name}</strong>,</p>
      <p>You have been added as a user to StatusFe. Click the button below to set up your password and access your account:</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 32px; background: #10b981; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600;">Set My Password</a>
      </p>
      <p style="color: #64748b; font-size: 13px;">If the button doesn't work, copy and paste this link into your browser:<br><code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${resetUrl}</code></p>
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
      <p style="color: #64748b; font-size: 13px;">This link will expire in 24 hours.</p>
      <p style="color: #64748b; font-size: 13px;">StatusFe Notification</p>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"${nameFrom}" <${from}>`,
    to: email,
    subject: 'Welcome to StatusFe - Set Your Password',
    html,
  });
  console.log('Welcome email sent to:', email);
  return { ok: true };
}

module.exports = { sendEmail, notifyComponentStatusChange, notifyIncident, sendWelcomeEmail };
