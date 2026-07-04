#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { renderCorreoCredenciales, renderCorreoRestablecimiento, renderCorreoAsignacionSemanal } = require('./index.js');

const OUT = path.join(__dirname, 'preview-output');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const correos = [
    {
        nombre: 'credenciales-empleado.html',
        html: renderCorreoCredenciales({
            nombre: 'Ana García',
            email: 'ana.garcia@empresa.com',
            password: 'Temp@2026!',
            rol: 'EMPLEADO',
            idEmpleado: 'EMP-0042',
            urlLogin: 'https://ilpeatransports.site',
            asunto: 'Credenciales de acceso — ILPEA Transporte',
            perfil: 'Empleado',
            rows: [
                { label: 'Perfil', value: 'Empleado' },
                { label: 'ID empleado', value: 'EMP-0042', monospace: true },
                { label: 'Nombre', value: 'Ana García' },
                { label: 'Correo', value: 'ana.garcia@empresa.com' },
                { label: 'Contraseña temporal', value: 'Temp@2026!', destacado: true, monospace: true },
            ],
        }),
    },
    {
        nombre: 'credenciales-camionero.html',
        html: renderCorreoCredenciales({
            nombre: 'Roberto Méndez',
            email: 'roberto.mendez@empresa.com',
            password: 'Temp@2026!',
            rol: 'CAMIONERO',
            idEmpleado: 'CAM-0015',
            urlLogin: 'https://ilpeatransports.site',
            asunto: 'Credenciales de camionero — ILPEA Transporte',
            perfil: 'Camionero',
            rows: [
                { label: 'Perfil', value: 'Camionero' },
                { label: 'ID camionero', value: 'CAM-0015', monospace: true },
                { label: 'Nombre', value: 'Roberto Méndez' },
                { label: 'Correo', value: 'roberto.mendez@empresa.com' },
                { label: 'Contraseña temporal', value: 'Temp@2026!', destacado: true, monospace: true },
            ],
        }),
    },
    {
        nombre: 'restablecimiento.html',
        html: renderCorreoRestablecimiento({
            email: 'ana.garcia@empresa.com',
            enlace: 'https://ilpeatransports.site/reset?token=abc123xyz',
        }),
    },
    {
        nombre: 'asignacion-semanal.html',
        html: renderCorreoAsignacionSemanal({
            nombre: 'Carlos López',
            titulo: 'Tienes una nueva asignación',
            intro: 'Fuiste asignado a una ruta y turno para la semana indicada. Guarda esta información para tu viaje.',
            asunto: 'Nueva asignación de ruta — ILPEA Transporte',
            rows: [
                { label: 'Semana', value: 'Semana 27 de 2026' },
                { label: 'Fecha de viaje', value: 'lunes 6 de julio de 2026<br />martes 7 de julio de 2026<br />miércoles 8 de julio de 2026' },
                { label: 'Turno', value: 'Mañana' },
                { label: 'Ruta', value: 'Ruta Norte — Express' },
                { label: 'Asiento', value: '12A', destacado: true },
                { label: 'Parada', value: 'Av. Insurgentes Norte #420' },
                { label: 'Unidad', value: 'U-007 · Autobús Mercedes' },
                { label: 'ID empleado', value: 'EMP-0042', monospace: true },
                { label: 'Correo', value: 'carlos.lopez@empresa.com' },
            ],
            urlPanel: 'https://ilpeatransports.site/empleado',
            esActualizacion: false,
        }),
    },
    {
        nombre: 'asignacion-actualizacion.html',
        html: renderCorreoAsignacionSemanal({
            nombre: 'Carlos López',
            titulo: 'Tu asignación fue actualizada',
            intro: 'Se actualizaron los datos de tu programación semanal. Revisa el detalle a continuación.',
            asunto: 'Actualización de tu asignación — ILPEA Transporte',
            rows: [
                { label: 'Semana', value: 'Semana 27 de 2026' },
                { label: 'Fecha de viaje', value: 'jueves 9 de julio de 2026' },
                { label: 'Turno', value: 'Tarde' },
                { label: 'Ruta', value: 'Ruta Sur — Local' },
                { label: 'ID empleado', value: 'EMP-0042', monospace: true },
                { label: 'Correo', value: 'carlos.lopez@empresa.com' },
            ],
            urlPanel: 'https://ilpeatransports.site/empleado',
            esActualizacion: true,
        }),
    },
];

correos.forEach(({ nombre, html }) => {
    const file = path.join(OUT, nombre);
    fs.writeFileSync(file, html, 'utf8');
    console.log(`✓  ${file}`);
});

console.log('\nAbre cualquiera en tu navegador:');
correos.forEach(({ nombre }) => console.log(`   xdg-open emails/preview-output/${nombre}`));
