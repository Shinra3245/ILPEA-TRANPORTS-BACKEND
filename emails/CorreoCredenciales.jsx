const React = require('react');
const { EmailLayout, CredentialTable, AlertBox, ActionButton } = require('./shared.jsx');

function CorreoCredenciales({ nombre, email, password, rol, idEmpleado, urlLogin, asunto, perfil, rows }) {
    return (
        <EmailLayout title={asunto} footerNote="Mensaje automático de ILPEA Transporte. No respondas a este correo. Si no solicitaste esta cuenta, contacta a tu administrador.">
            {/* Saludo */}
            <tr>
                <td style={{ padding: '32px 32px 8px' }}>
                    <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#000000', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Bienvenido(a), {nombre}
                    </p>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#374151', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Se creó tu cuenta de <strong>{perfil}</strong> en ILPEA Transporte.
                        Usa las credenciales siguientes para iniciar sesión.
                    </p>
                </td>
            </tr>
            {/* Tabla credenciales */}
            <tr>
                <td style={{ padding: '20px 32px 8px' }}>
                    <CredentialTable rows={rows} />
                </td>
            </tr>
            {/* Aviso seguridad */}
            <tr>
                <td style={{ padding: '16px 32px 8px' }}>
                    <AlertBox variant="amber">
                        Por seguridad, cambia tu contraseña después del primer acceso.
                    </AlertBox>
                </td>
            </tr>
            {/* Botón login */}
            {urlLogin ? (
                <tr>
                    <td style={{ padding: '8px 32px 32px', textAlign: 'center' }}>
                        <ActionButton href={urlLogin} label="Ingresar al sistema" variant="black" />
                        <p style={{ margin: '8px 0 0', textAlign: 'center', fontSize: 12, color: '#6b7280', fontFamily: 'Inter, Arial, sans-serif' }}>
                            {urlLogin}
                        </p>
                    </td>
                </tr>
            ) : (
                <tr><td style={{ paddingBottom: 32 }} /></tr>
            )}
        </EmailLayout>
    );
}

module.exports = { CorreoCredenciales };
