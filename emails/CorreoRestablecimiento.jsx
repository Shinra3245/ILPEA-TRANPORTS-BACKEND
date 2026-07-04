const React = require('react');
const { EmailLayout, CredentialTable, AlertBox, ActionButton } = require('./shared.jsx');

function CorreoRestablecimiento({ email, enlace }) {
    const asunto = 'Restablece tu contraseña — ILPEA Transporte';
    return (
        <EmailLayout title={asunto} footerNote="Mensaje automático de ILPEA Transporte. No respondas a este correo. Si no solicitaste restablecer tu contraseña, contacta a tu administrador.">
            {/* Título */}
            <tr>
                <td style={{ padding: '32px 32px 8px' }}>
                    <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#000000', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Restablece tu contraseña
                    </p>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#374151', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Recibimos una solicitud para restablecer la contraseña de la cuenta asociada a{' '}
                        <strong style={{ color: '#000000' }}>{email}</strong>.
                    </p>
                </td>
            </tr>
            {/* Info tabla */}
            <tr>
                <td style={{ padding: '20px 32px 8px' }}>
                    <CredentialTable rows={[
                        { label: 'Correo', value: email },
                        { label: 'Validez del enlace', value: '1 hora', isLast: true },
                    ]} />
                </td>
            </tr>
            {/* Botón */}
            <tr>
                <td style={{ padding: '24px 32px 8px' }}>
                    <ActionButton href={enlace} label="Restablecer contraseña" variant="green" centered={false} />
                </td>
            </tr>
            {/* Enlace alternativo */}
            <tr>
                <td style={{ padding: '8px 32px 16px' }}>
                    <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Si el botón no funciona, copia este enlace en tu navegador:
                    </p>
                    <p style={{ margin: 0, fontSize: 12, color: '#107c41', wordBreak: 'break-all', fontFamily: 'Inter, Arial, sans-serif' }}>
                        {enlace}
                    </p>
                </td>
            </tr>
            {/* Aviso seguridad */}
            <tr>
                <td style={{ padding: '0 32px 24px' }}>
                    <AlertBox variant="amber">
                        Si no solicitaste este cambio, ignora este correo. Tu contraseña no será modificada.
                    </AlertBox>
                </td>
            </tr>
        </EmailLayout>
    );
}

module.exports = { CorreoRestablecimiento };
