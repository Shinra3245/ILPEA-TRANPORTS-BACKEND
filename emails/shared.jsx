const React = require('react');

// ── Estilos base ──────────────────────────────────────────────────
const S = {
    body: { margin: 0, padding: 0, background: '#f3f4f6', fontFamily: 'Inter, Arial, sans-serif' },
    wrapper: { background: '#f3f4f6', padding: '32px 16px', width: '100%' },
    card: { maxWidth: 600, margin: '0 auto', background: '#ffffff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' },
    headerTd: { background: '#000000', padding: '28px 32px 24px' },
    brand: { margin: '0 0 4px', fontSize: 22, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em', fontFamily: 'Inter, Arial, sans-serif' },
    brandSub: { margin: 0, fontSize: 13, color: '#9ca3af', letterSpacing: '0.06em', textTransform: 'uppercase', fontFamily: 'Inter, Arial, sans-serif' },
    greenBar: { height: 4, background: '#107c41', fontSize: 0, lineHeight: 0 },
    footer: { padding: '20px 32px', background: '#f9fafb', borderTop: '1px solid #e5e7eb' },
    footerText: { margin: 0, fontSize: 12, lineHeight: 1.5, color: '#6b7280', textAlign: 'center', fontFamily: 'Inter, Arial, sans-serif' },
};

// ── Layout base compartido ────────────────────────────────────────
function EmailLayout({ title, children, footerNote }) {
    return (
        <html lang="es">
            <head>
                <meta charSet="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>{title}</title>
            </head>
            <body style={S.body}>
                <table role="presentation" width="100%" cellSpacing="0" cellPadding="0" border="0" style={S.wrapper}>
                    <tr>
                        <td align="center">
                            <table role="presentation" width="100%" cellSpacing="0" cellPadding="0" border="0" style={S.card}>
                                {/* Encabezado negro */}
                                <tr>
                                    <td style={S.headerTd}>
                                        <p style={S.brand}>ILPEA Transporte</p>
                                        <p style={S.brandSub}>Gestión de flota</p>
                                    </td>
                                </tr>
                                {/* Barra verde */}
                                <tr><td style={S.greenBar}>&nbsp;</td></tr>
                                {/* Contenido */}
                                {children}
                                {/* Pie */}
                                <tr>
                                    <td style={S.footer}>
                                        <p style={S.footerText}>
                                            {footerNote || 'Mensaje automático de ILPEA Transporte. No respondas a este correo.'}
                                        </p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </body>
        </html>
    );
}

// ── Tabla de credenciales ─────────────────────────────────────────
function CredentialRow({ label, value, isLast, monospace, destacado }) {
    const border = isLast ? {} : { borderBottom: '1px solid #e5e7eb' };
    const labelStyle = {
        padding: '14px 18px', ...border,
        color: '#6b7280', fontSize: 12, fontWeight: 700,
        letterSpacing: '0.04em', textTransform: 'uppercase',
        width: '38%', background: '#f9fafb', verticalAlign: 'top',
        fontFamily: 'Inter, Arial, sans-serif',
    };
    const valueStyle = {
        padding: '14px 18px', ...border,
        color: '#000000', fontSize: 14,
        fontWeight: destacado ? 700 : 600,
        background: '#ffffff', verticalAlign: 'top',
        fontFamily: monospace ? "'Courier New', Courier, monospace" : 'Inter, Arial, sans-serif',
    };
    return (
        <tr>
            <td style={labelStyle}>{label}</td>
            <td style={valueStyle} dangerouslySetInnerHTML={{ __html: value }} />
        </tr>
    );
}

function CredentialTable({ rows }) {
    return (
        <table role="presentation" width="100%" cellSpacing="0" cellPadding="0" border="0"
            style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <tbody>
                {rows.map((row, i) => (
                    <CredentialRow key={i} {...row} isLast={i === rows.length - 1} />
                ))}
            </tbody>
        </table>
    );
}

// ── Caja de alerta (amber o green) ───────────────────────────────
function AlertBox({ children, variant = 'amber' }) {
    const isGreen = variant === 'green';
    return (
        <table role="presentation" width="100%" cellSpacing="0" cellPadding="0" border="0"
            style={{ background: isGreen ? '#ecfdf5' : '#fffbeb', borderLeft: `4px solid ${isGreen ? '#107c41' : '#f59e0b'}`, borderRadius: 8 }}>
            <tr>
                <td style={{ padding: '14px 16px', fontSize: 13, lineHeight: 1.5, color: isGreen ? '#065f46' : '#92400e', fontFamily: 'Inter, Arial, sans-serif' }}>
                    {children}
                </td>
            </tr>
        </table>
    );
}

// ── Botón de acción ───────────────────────────────────────────────
function ActionButton({ href, label, variant = 'black', centered = true }) {
    const bg = variant === 'green' ? '#107c41' : '#000000';
    const tableStyle = centered ? { margin: '28px auto 8px' } : {};
    return (
        <table role="presentation" cellSpacing="0" cellPadding="0" border="0" style={tableStyle}>
            <tr>
                <td style={{ borderRadius: 8, background: bg }}>
                    <a href={href} target="_blank" rel="noopener noreferrer"
                        style={{ display: 'inline-block', padding: '14px 28px', fontFamily: 'Inter, Arial, sans-serif', fontSize: 14, fontWeight: 700, color: '#ffffff', textDecoration: 'none', letterSpacing: '0.03em' }}>
                        {label}
                    </a>
                </td>
            </tr>
        </table>
    );
}

module.exports = { EmailLayout, CredentialTable, AlertBox, ActionButton };
