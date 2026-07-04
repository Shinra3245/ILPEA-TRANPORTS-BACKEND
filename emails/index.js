require('esbuild-register/dist/node').register({ extensions: ['.jsx'] });

const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const { CorreoCredenciales } = require('./CorreoCredenciales.jsx');
const { CorreoRestablecimiento } = require('./CorreoRestablecimiento.jsx');
const { CorreoAsignacionSemanal } = require('./CorreoAsignacionSemanal.jsx');

function renderEmail(Component, props) {
    return '<!DOCTYPE html>' + renderToStaticMarkup(React.createElement(Component, props));
}

module.exports = {
    renderCorreoCredenciales: (props) => renderEmail(CorreoCredenciales, props),
    renderCorreoRestablecimiento: (props) => renderEmail(CorreoRestablecimiento, props),
    renderCorreoAsignacionSemanal: (props) => renderEmail(CorreoAsignacionSemanal, props),
};
