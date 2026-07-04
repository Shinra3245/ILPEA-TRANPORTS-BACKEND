const React = require('react');
const { EmailLayout, CredentialTable, AlertBox, ActionButton } = require('./shared.jsx');

function CorreoAsignacionSemanal({ nombre, titulo, intro, asunto, rows, urlPanel, esActualizacion }) {
    return (
        <EmailLayout
            title={asunto}
            footerNote="Mensaje automático de ILPEA Transporte. No respondas a este correo. Si detectas un error en tu asignación, contacta a tu administrador o jefe de turno."
        >
            {/* Saludo y contexto */}
            <tr>
                <td style={{ padding: '32px 32px 8px' }}>
                    <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#000000', fontFamily: 'Inter, Arial, sans-serif' }}>
                        {titulo}
                    </p>
                    <p style={{ margin: '0 0 8px', fontSize: 15, lineHeight: 1.6, color: '#374151', fontFamily: 'Inter, Arial, sans-serif' }}>
                        Hola <strong style={{ color: '#000000' }}>{nombre}</strong>,
                    </p>
                    <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: '#374151', fontFamily: 'Inter, Arial, sans-serif' }}>
                        {intro}
                    </p>
                </td>
            </tr>
            {/* Tabla detalle */}
            <tr>
                <td style={{ padding: '20px 32px 8px' }}>
                    <CredentialTable rows={rows} />
                </td>
            </tr>
            {/* Aviso QR */}
            <tr>
                <td style={{ padding: '16px 32px 8px' }}>
                    <AlertBox variant="green">
                        Presenta tu código QR en el abordaje el día de tu viaje. Si tienes dudas, contacta a tu jefe de turno.
                    </AlertBox>
                </td>
            </tr>
            {/* Botón panel */}
            {urlPanel ? (
                <tr>
                    <td style={{ padding: '8px 32px 32px', textAlign: 'center' }}>
                        <ActionButton href={urlPanel} label="Ver mi asignación" variant="green" />
                        <p style={{ margin: '8px 0 0', textAlign: 'center', fontSize: 12, color: '#6b7280', fontFamily: 'Inter, Arial, sans-serif' }}>
                            {urlPanel}
                        </p>
                    </td>
                </tr>
            ) : (
                <tr><td style={{ paddingBottom: 32 }} /></tr>
            )}
        </EmailLayout>
    );
}

module.exports = { CorreoAsignacionSemanal };
